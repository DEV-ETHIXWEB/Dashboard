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
    const clientId = req.user.role === 'client' ? req.user.id : req.query.clientId;
    if (!clientId) return res.json({ queued: [] });
    if (req.user.role === 'client' && clientId !== req.user.id) return res.json({ queued: [] });

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
    const { subject, category, description } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject is required' });

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
          subject, category, description, priority: req.body.priority,
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

    const priority = intake.normalizePriority(req.body.priority);
    const ticket = await db.insert('tickets', {
      id: await intake.nextTicketId(),
      subject, category: category || 'General', clientId, assigneeId: null,
      status: 'Open', description: description || '', createdAt: new Date().toISOString(),
      priority, responseDueAt: intake.responseDueAt(priority), firstResponseAt: null,
    });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [clientId];
    await audit(req.user.id, 'create', 'ticket', ticket.id);

    // Auto-assign, start it in ClickUp, then alert the team in-app, on Slack,
    // and over email -- all handled in one place.
    const routed = await intake.onTicketCreated(ticket);

    res.status(201).json({ ticket: routed, chargedAsExtra: Boolean(gate.extra) });
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

    const patch = isStaff ? { ...req.body } : { description: req.body.description };
    delete patch.id;
    delete patch.createdAt;
    // The ClickUp link is owned by the mirroring code, never by the client.
    delete patch.clickupTaskId;
    delete patch.clickupTaskUrl;

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

    const updated = await db.update('tickets', req.params.id, patch);
    // Tell this client's open tabs, not everyone's -- and when the ticket has
    // changed hands, both sides, or the new owner's tabs never hear that it
    // arrived and the old owner's never hear that it left.
    res.locals.liveAudience = [...new Set([ticket.clientId, updated.clientId].filter(Boolean))];
    await audit(req.user.id, 'update', 'ticket', req.params.id, {
      changed: Object.keys(patch),
      ...(movingClient ? { clientFrom: ticket.clientId, clientTo: updated.clientId } : {}),
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
