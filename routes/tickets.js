'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const approvals = require('../utils/approvals');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const { requirePage } = require('../utils/clientPages');
const clickup = require('../utils/clickup');
const workflow = require('../utils/ticketWorkflow');
const intake = require('../utils/ticketIntake');
const mailer = require('../utils/mailer');
const messages = require('../utils/emailMessages');
const slaWatch = require('../utils/slaWatch');
const ticketStatus = require('../utils/ticketStatus');
const updateRequests = require('../utils/updateRequests');
const upsellTracking = require('../utils/upsell');
const plans = require('../lib/plans');
const subscriptions = require('../utils/subscriptions');
const membershipEvents = require('../utils/membershipEvents');

router.use(requireAuth);
router.use(requirePage('tickets'));

// Visibility now also covers collaborators, so `visibleTo` is async.
const visibleTo = (user, ticket) => workflow.canView(user, ticket);

/**
 * Load the ticket named in the URL and check the caller may see it, so every
 * sub-route below starts from a verified ticket instead of repeating the check.
 */
async function loadTicket(req, res, next) {
  try {
    const ticket = await db.find('tickets', req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!(await visibleTo(req.user, ticket))) {
      return res.status(403).json({ error: 'Not allowed to view this ticket' });
    }
    req.ticket = ticket;
    next();
  } catch (err) {
    next(err);
  }
}

/** Turn a WorkflowError into its intended status instead of a blanket 500. */
function handleWorkflow(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof workflow.WorkflowError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  };
}

/** Tell the new owner, by email, that a ticket is now theirs. */
async function announceAssignment(ticket, assigneeId, actor) {
  try {
    const [assignee, client] = await Promise.all([
      db.find('users', assigneeId),
      ticket.clientId ? db.find('users', ticket.clientId) : null,
    ]);
    if (!assignee?.email) return;

    await intake.echoActivity(ticket, `👤 *${actor.name}* assigned ${ticket.id} to *${assignee.name}*`);
    await mailer.sendTemplate({
      to: assignee.email,
      message: messages.ticketAssigned({
        ticket, assigneeName: assignee.name, clientName: client?.name || null, actorName: actor.name, actor,
      }),
      template: 'ticket_assigned',
      entity: 'ticket',
      entityId: ticket.id,
    });
  } catch (err) {
    console.error(`Could not announce the assignment on ticket ${ticket.id}:`, err.message);
  }
}

router.get('/', async (req, res, next) => {
  try {
    // Deadline alerts ride along on normal traffic rather than a scheduler,
    // and are throttled inside maybeSweep. Deliberately not awaited: nobody
    // should wait on outbound email to see their ticket list.
    if (['admin', 'project_manager'].includes(req.user.role)) void slaWatch.maybeSweep();

    /**
     * Each role is asked for from the database rather than filtered out of
     * the whole table in memory.
     *
     * A client sees their own tickets and nothing else, so that is an indexed
     * lookup on client_id -- not a read of every ticket in the workspace
     * followed by a per-ticket permission check. With real data behind it the
     * old shape read tens of thousands of rows to answer with two, and on
     * Firestore every one of those reads is billed.
     */
    if (req.user.role === 'client') {
      return res.json({
        tickets: await db.where('tickets', { clientId: req.user.id }, { orderBy: 'createdAt' }),
      });
    }

    // An employee sees what they are assigned plus what they were invited
    // onto. Both are small, known sets, so neither needs a scan.
    if (req.user.role === 'employee') {
      const assigned = await db.where('tickets', { assigneeId: req.user.id }, { orderBy: 'createdAt' });
      const seen = new Set(assigned.map((t) => t.id));

      const invites = await db.where('ticket_collaborators', { userId: req.user.id });
      for (const invite of invites) {
        if (seen.has(invite.ticketId)) continue;
        const ticket = await db.find('tickets', invite.ticketId);
        if (ticket) { assigned.push(ticket); seen.add(ticket.id); }
      }

      return res.json({
        tickets: assigned.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
      });
    }

    // Managers and sales see everything, which is the one case that genuinely
    // has to read the table.
    const all = await db.all('tickets');
    const visible = [];
    for (const t of all) if (await visibleTo(req.user, t)) visible.push(t);
    res.json({ tickets: visible });
  } catch (err) {
    next(err);
  }
});

/** Requests waiting on the signed-in user -- drives the "needs you" inbox. */
router.get('/requests/mine', async (req, res, next) => {
  try {
    const requests = await workflow.pendingRequestsFor(req.user.id);
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

router.get('/stages', (req, res) => res.json({ stages: workflow.STAGES }));

/**
 * Requests this client chose to hold until their allowance resets.
 *
 * Deliberately a separate list from the ticket queue: these are not work the
 * team owes an answer on yet, and showing them there would start an SLA clock
 * nobody agreed to. The client sees what they are holding and when it lands.
 */
router.get('/queued', async (req, res, next) => {
  try {
    if (req.user.role === 'client') {
      return res.json({ queued: await updateRequests.queuedFor(req.user.id) });
    }

    /**
     * A held request is the full text of something a client has not agreed to
     * have done yet, named with the client it belongs to. Any signed-in staff
     * account could read any client's -- sales, an employee working one
     * unrelated ticket, anybody -- which is a wider audience than the ticket
     * itself has, because a ticket at least has an assignee and a
     * collaborator list.
     *
     * Admins and project managers run the queue and need it. Nobody else does.
     */
    if (!['admin', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Held requests are not part of your role.' });
    }

    const clientId = req.query.clientId;
    if (!clientId) return res.json({ queued: [] });

    res.json({ queued: await updateRequests.queuedFor(clientId) });
  } catch (err) {
    next(err);
  }
});

/** Change their mind about holding one. It was never a ticket, so nothing closes. */
router.delete('/queued/:id', requireCSRF, async (req, res, next) => {
  try {
    const held = await db.find('queued_requests', req.params.id);
    if (!held) return res.status(404).json({ error: 'That request is not being held.' });
    if (req.user.role === 'client' && held.clientId !== req.user.id) {
      return res.status(403).json({ error: 'That is not your request.' });
    }

    await db.update('queued_requests', held.id, { cancelledAt: new Date().toISOString() });
    res.locals.liveAudience = [held.clientId];
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, async (req, res, next) => {
  try {
    /**
     * The body, checked before a single decision is taken on it.
     *
     * The category decides two things that cost money -- whether the plan
     * allows the request at all, and whether it spends one of the month's
     * updates -- and it was taken as whatever arrived. `{ category: ['Site
     * down'] }` stringified to exactly the label that means "do not count
     * this", so a Managed client could file unlimited uncounted change
     * requests by wrapping the category in an array. The subject and
     * description were unbounded besides.
     */
    const fields = intake.validateTicketFields(req.body || {});
    if (!fields.ok) return res.status(400).json({ error: fields.error });
    const { subject, category, description } = fields.value;

    const clientId = req.user.role === 'client' ? req.user.id : req.body.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    /**
     * What the client's plan allows.
     *
     * Only a client is gated. Staff raise tickets on a client's behalf all the
     * time -- after a phone call, off the back of a text -- and refusing those
     * would mean the plan limits the team rather than the customer. The limit
     * is on what a client may ask for unprompted, not on what we may record.
     *
     * The answers come back as decisions rather than refusals: out of
     * allowance offers paying for the extra, waiting, or upgrading, and every
     * one of them keeps what they typed. Nothing in here ever discards the
     * body of the request.
     */
    let gate = { ok: true, counts: false };
    if (req.user.role === 'client') {
      gate = await updateRequests.check(req.user, { category });

      if (!gate.ok && req.body.queueForNextPeriod === true && gate.reason === 'allowance_used') {
        const held = await updateRequests.queue(clientId, {
          subject, category, description, priority: fields.value.priority,
          releaseAt: gate.resetsAt,
        });
        res.locals.liveAudience = [clientId];
        return res.status(202).json({
          queued: held,
          message: `Saved. We will pick this up on ${new Date(gate.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}, `
            + 'when your next updates unlock.',
        });
      }

      // Paying for one past the allowance. The work gets done and we quote it
      // per job, so nothing here names a price -- the client is agreeing to be
      // quoted, not to a number we invented.
      const payingExtra = !gate.ok
        && gate.reason === 'allowance_used'
        && gate.chargeable
        && req.body.acceptExtraCharge === true;

      if (!gate.ok && !payingExtra) {
        // This is an upgrade prompt, so it spends the week's budget. A client
        // who was offered Unlimited here on Monday must not also get a modal
        // about it on Wednesday -- the ceiling in utils/upsell.js counts these
        // alongside its own. Not awaited: the refusal is the answer, and an
        // analytics write is not a reason to delay it.
        if (gate.reason === 'allowance_used' || gate.reason === 'category_not_included') {
          void upsellTracking.markShown(req.user, {
            messageKey: null,
            trigger: gate.reason,
          }).catch(() => {});
        }

        return res.status(gate.reason === 'allowance_used' ? 409 : 403).json({
          error: gate.message,
          upgradeRequired: true,
          reason: gate.reason,
          recommended: gate.recommended || null,
          resetsAt: gate.resetsAt || null,
          chargeable: Boolean(gate.chargeable),
          usage: gate.usage || null,
        });
      }

      if (payingExtra) {
        await updateRequests.consumeExtra(clientId, gate.state);
        gate = { ...gate, ok: true, counts: false, extra: true };
      } else if (gate.tracked) {
        // An outage, a billing query or a question. It does not spend the
        // allowance and never will -- but it is counted, because these are the
        // categories a client declares for themselves and an improbable number
        // of them in one month is something the team should be told about.
        // Not awaited: it is bookkeeping, and the request is the answer.
        void updateRequests.consumeNonUpdate(clientId, gate.state, { category })
          .catch(() => {});
      } else if (gate.counts) {
        // Atomic, and the last line of defence: if two requests were submitted
        // in the same second, the second one loses here rather than quietly
        // becoming a third free update.
        const took = await updateRequests.consume(clientId, gate.state);
        if (!took) {
          const fresh = await updateRequests.check(req.user, { category });
          return res.status(409).json({
            error: fresh.message || 'That used the last of your updates for this month.',
            upgradeRequired: true,
            reason: 'allowance_used',
            recommended: fresh.recommended || null,
            resetsAt: fresh.resetsAt || null,
            chargeable: Boolean(fresh.chargeable),
            usage: fresh.usage || null,
          });
        }
      }
    }

    /**
     * The priority a client actually gets, capped by their plan.
     *
     * Unlimited is sold on "priority support with a guaranteed response time",
     * and until now every client could reach for it: Urgent was in the
     * dropdown on every plan and bought a one-hour response target. Staff are
     * not capped, and an outage is not capped on any plan.
     */
    let priorityCap = null;
    if (req.user.role === 'client') {
      priorityCap = plans.capPriority(gate.state?.effectivePlanKey, fields.value.priority, { category });
    }
    const priority = priorityCap ? priorityCap.priority : fields.value.priority;

    const ticket = await intake.insertTicket({
      subject, category, clientId, assigneeId: null,
      status: 'Open', description: description || '', createdAt: new Date().toISOString(),
      priority, responseDueAt: intake.responseDueAt(priority), firstResponseAt: null,
    });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [clientId];
    await audit(req.user.id, 'create', 'ticket', ticket.id);

    // Auto-assign, start it in ClickUp, then alert the team in-app, on Slack,
    // and over email -- all handled in one place.
    const routed = await intake.onTicketCreated(ticket);

    res.status(201).json({
      ticket: routed,
      chargedAsExtra: Boolean(gate.extra),
      // Said plainly rather than silently applied: a client who chose Urgent
      // and sees "Normal" on their ticket with no explanation has been lied
      // to by a form. This is also the one upgrade prompt that arrives at the
      // exact moment the thing being sold would have helped.
      ...(priorityCap?.capped
        ? {
          priorityCapped: {
            requested: fields.value.priority,
            applied: priorityCap.priority,
            message: `Your plan covers up to ${priorityCap.ceiling} priority, so this came in as `
              + `${priorityCap.priority}. Unlimited includes priority support with a guaranteed `
              + 'response time -- and an outage always comes in as urgent, whatever your plan.',
            recommended: 'unlimited',
          },
        }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCSRF, async (req, res, next) => {
  try {
    const ticket = await db.find('tickets', req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const isStaff = ['admin', 'project_manager', 'employee'].includes(req.user.role);
    const isOwner = req.user.role === 'client' && ticket.clientId === req.user.id;
    if (!isStaff && !isOwner) return res.status(403).json({ error: 'Not allowed to edit this ticket' });

    // "Staff" was one bucket, so an employee had exactly the reach of an admin
    // over every ticket in the workspace. An employee works on the tickets that
    // are theirs: assigned to them, or one they were brought onto. Admins and
    // project managers still see the whole queue, which is their job.
    if (req.user.role === 'employee') {
      const collaborators = await db.filter(
        'ticket_collaborators',
        (c) => c.ticketId === req.params.id && c.userId === req.user.id,
      );
      const mine = ticket.assigneeId === req.user.id || collaborators.length > 0;
      if (!mine) {
        return res.status(403).json({ error: 'This ticket is not assigned to you.' });
      }
    }

    /**
     * The text fields on an edit, held to the same rules as on creation.
     *
     * A category refused at creation could be set on the next PUT, which with
     * a billing rule on the other side of it is the same hole one request
     * later. Nothing in the body is required here -- a patch that does not
     * mention the subject is leaving it alone -- but anything that *is*
     * mentioned has to be a real value.
     */
    const edited = intake.validateTicketFields(req.body || {}, {
      requireSubject: false, requireCategory: false,
    });
    if (!edited.ok) return res.status(400).json({ error: edited.error });

    /**
     * The fields an edit may touch, named rather than subtracted.
     *
     * Spreading the body and deleting the dangerous keys works only while
     * somebody remembers to add a `delete` for every column that gets added,
     * and several were never on that list: `responseDueAt` let a member of
     * staff move their own SLA deadline, `firstResponseAt` let them rewrite
     * whether they had answered at all, and `status` was free text, so a
     * ticket could be put into a state nothing else in the product
     * understands.
     */
    const EDITABLE = [
      'subject', 'description', 'category', 'status', 'priority',
      'assigneeId', 'clientId', 'progress', 'stage',
    ];
    const patch = {};
    if (isStaff) {
      for (const field of EDITABLE) {
        if (field in req.body) patch[field] = req.body[field];
      }
    } else if ('description' in req.body) {
      // A client may correct what they asked for and nothing else.
      patch.description = req.body.description;
    }

    // Whatever survives is the cleaned version, not the raw body.
    if ('subject' in patch) patch.subject = edited.value.subject;
    if ('description' in patch) patch.description = edited.value.description;
    if ('category' in patch) patch.category = edited.value.category;

    if (patch.status !== undefined && !ticketStatus.STATUSES.includes(patch.status)) {
      return res.status(400).json({
        error: `A ticket status has to be one of: ${ticketStatus.STATUSES.join(', ')}.`,
      });
    }

    /**
     * A ticket belongs to somebody on the team, or to nobody.
     *
     * `assigneeId` was written straight through, so a ticket could be assigned
     * to a client -- who would then be notified that a ticket was "theirs" and
     * could see it in their own queue -- or to an id belonging to nobody, in
     * which case it silently stopped being anybody's job. The tasks route has
     * validated this all along; tickets never did.
     */
    if ('assigneeId' in patch && patch.assigneeId) {
      const assignee = await db.find('users', patch.assigneeId);
      if (!assignee || !['admin', 'project_manager', 'employee'].includes(assignee.role)) {
        return res.status(400).json({ error: 'A ticket can only be assigned to a member of the team.' });
      }
    }

    // Which client a ticket belongs to decides which portal shows it. Moving a
    // ticket sideways puts one client's support request in front of another,
    // so it is an administrator's decision, not part of working the ticket.
    const movingClient = 'clientId' in patch && patch.clientId !== ticket.clientId;
    if (movingClient && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can move a ticket to a different client.' });
    }
    if (movingClient) {
      const nextClient = await db.find('users', patch.clientId);
      if (!nextClient || nextClient.role !== 'client') {
        return res.status(400).json({ error: 'That is not a client account.' });
      }
    } else {
      delete patch.clientId;
    }

    if (patch.priority) {
      patch.priority = intake.normalizePriority(patch.priority);
      // Re-basing the clock on the original open time keeps the SLA honest.
      patch.responseDueAt = intake.responseDueAt(patch.priority, new Date(ticket.createdAt).getTime());
    }
    delete patch.firstResponseAt;

    const closing = patch.status
      && patch.status !== ticket.status
      && ticketStatus.isClosing(patch.status);

    // Telling a client their request is finished is not a change you take back,
    // so an admin nobody has vouched for proposes it and a trusted admin
    // confirms. Everything else about the ticket saves as normal.
    if (closing) {
      const gate = await approvals.gate(req, res, {
        action: 'ticket.close',
        summary: `Mark "${ticket.subject}" (${ticket.id}) as ${patch.status} and tell the client`,
        payload: {
          ticketId: req.params.id,
          toStatus: patch.status,
          patch: (({ status, ...rest }) => rest)(patch),
        },
      });
      if (gate.held) return;
    }

    /**
     * Staff deciding this was a change request after all.
     *
     * The categories that do not count -- an outage, a billing query, a
     * question -- are the ones a client declares for themselves, so the way to
     * get free change work on a capped plan was to file it as one of those.
     * Refusing outages is not an option and never will be. Correcting the
     * record is: when somebody on the team moves a ticket from an uncounted
     * category to a real one, that is the moment it becomes a change request,
     * and it spends the allowance then.
     *
     * Only for a client's own capped plan, only in that direction, and only by
     * staff -- a client cannot re-categorise their way out of it, because the
     * branch above has already narrowed their patch to the description.
     */
    let recategorised = null;
    if (isStaff && patch.category && patch.category !== ticket.category && ticket.clientId) {
      const wasFree = !plans.isUpdateRequest(ticket.category);
      const nowCounts = plans.isUpdateRequest(patch.category);
      if (wasFree && nowCounts) {
        const client = await db.find('users', ticket.clientId);
        if (client?.role === 'client') {
          const state = await subscriptions.stateFor(client);
          const plan = plans.planFor(state.effectivePlanKey);
          if (plan && plan.updateRequestsPerMonth !== null && plan.updateRequestsPerMonth > 0) {
            // Inside the allowance, it comes off it. Past the allowance it is
            // an extra, which is what a Managed client is charged for anyway --
            // either way the work is now counted and neither one refuses a
            // ticket the team has already taken on.
            const took = await updateRequests.consume(ticket.clientId, state);
            if (!took) await updateRequests.consumeExtra(ticket.clientId, state);
            recategorised = { from: ticket.category, to: patch.category, charged: took ? 'allowance' : 'extra' };
            await membershipEvents.log('request_recategorised', {
              clientId: ticket.clientId,
              actorId: req.user.id,
              metadata: { ticketId: ticket.id, ...recategorised },
            });
          }
        }
      }
    }

    const updated = await db.update('tickets', req.params.id, patch);
    // Tell this client's open tabs, not everyone's -- and when the ticket has
    // changed hands, both sides, or the new owner's tabs never hear that it
    // arrived and the old owner's never hear that it left.
    res.locals.liveAudience = [...new Set([ticket.clientId, updated.clientId].filter(Boolean))];
    await audit(req.user.id, 'update', 'ticket', req.params.id, {
      changed: Object.keys(patch),
      ...(movingClient ? { clientFrom: ticket.clientId, clientTo: updated.clientId } : {}),
      ...(recategorised ? { recategorised } : {}),
    });

    // Any staff touch counts as the first response.
    if (isStaff) await intake.markFirstResponse(updated, req.user);

    if (patch.status && patch.status !== ticket.status) {
      await notify(ticket.clientId, `Your ticket "${ticket.subject}" is now ${patch.status}`, 'ticket');
      await ticketStatus.syncToClickUp(ticket, patch.status);
      await ticketStatus.announce(updated, ticket.status, patch.status, req.user);
    }
    if (patch.assigneeId && patch.assigneeId !== ticket.assigneeId) {
      await notify(patch.assigneeId, `You were assigned ticket: "${ticket.subject}"`, 'ticket');
      await announceAssignment(updated, patch.assigneeId, req.user);
    }
    res.json({ ticket: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await db.find('tickets', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });

    const gate = await approvals.gate(req, res, {
      action: 'ticket.delete',
      summary: `Delete the ticket "${existing.subject}" (${existing.id})`,
      payload: { ticketId: req.params.id },
    });
    if (gate.held) return;

    const ok = await db.remove('tickets', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Ticket not found' });
    await audit(req.user.id, 'delete', 'ticket', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- collaboration ---------------------------------------------------------

/** The whole story of a ticket: notes, requests, and who is working it. */
router.get('/:id/timeline', loadTicket, handleWorkflow(async (req, res) => {
  const [allUpdates, collaborators] = await Promise.all([
    workflow.listUpdates(req.ticket.id),
    workflow.listCollaborators(req.ticket.id),
  ]);

  // A client follows their own ticket; they do not follow the team's staffing
  // of it. Handover and collaboration requests -- and the system notes that
  // record the answer -- are internal traffic, so they are dropped here rather
  // than hidden in the browser: a row filtered in React has still been sent.
  const updates = req.user.role === 'client'
    ? allUpdates.filter((u) => u.kind === workflow.KINDS.PROGRESS)
    : allUpdates;

  // Names travel with the timeline instead of being looked up in the browser.
  // `GET /users` is deliberately narrow for a client -- themselves, their PM,
  // and whoever is assigned -- so an update written by anybody else had no
  // name to resolve and rendered as "Someone". This tells them exactly one
  // thing more: who wrote the message they are already reading.
  const names = await workflow.nameMap([
    req.ticket.assigneeId,
    ...updates.map((u) => u.authorId),
    ...updates.map((u) => u.targetUserId),
    ...collaborators.map((c) => c.userId),
  ]);

  res.json({
    ticket: req.ticket,
    assigneeName: names.get(req.ticket.assigneeId) || null,
    updates: updates.map((u) => ({
      ...u,
      authorName: names.get(u.authorId) || null,
      targetName: names.get(u.targetUserId) || null,
    })),
    collaborators: collaborators.map((c) => ({ ...c, name: names.get(c.userId) || null })),
    can: {
      recordProgress: await workflow.canRecordProgress(req.user, req.ticket),
      delegate: workflow.canDelegate(req.user, req.ticket),
    },
  });
}));

router.post('/:id/updates', requireCSRF, loadTicket, handleWorkflow(async (req, res) => {
  const { body, progress, stage } = req.body || {};
  // Clients may leave a note on their own ticket; only the team records progress.
  if (req.user.role !== 'client' && !(await workflow.canRecordProgress(req.user, req.ticket))) {
    return res.status(403).json({ error: 'Not allowed to post updates on this ticket' });
  }
  const update = await workflow.addProgressUpdate(req.user, req.ticket, { body, progress, stage });
  await intake.markFirstResponse(req.ticket, req.user);
  res.status(201).json({ update });
}));

router.post('/:id/handover', requireCSRF, loadTicket, handleWorkflow(async (req, res) => {
  const update = await workflow.createRequest(req.user, req.ticket, workflow.KINDS.HANDOVER, req.body || {});
  res.status(201).json({ request: update });
}));

router.post('/:id/collaboration', requireCSRF, loadTicket, handleWorkflow(async (req, res) => {
  const update = await workflow.createRequest(req.user, req.ticket, workflow.KINDS.COLLABORATION, req.body || {});
  res.status(201).json({ request: update });
}));

router.post('/:id/requests/:requestId/respond', requireCSRF, loadTicket, handleWorkflow(async (req, res) => {
  const accept = req.body?.accept === true;
  const resolved = await workflow.respondToRequest(req.user, req.ticket, req.params.requestId, accept);
  res.json({ request: resolved });
}));

router.delete('/:id/collaborators/:userId', requireCSRF, loadTicket, handleWorkflow(async (req, res) => {
  await workflow.removeCollaborator(req.user, req.ticket, req.params.userId);
  res.json({ ok: true });
}));

module.exports = router;
