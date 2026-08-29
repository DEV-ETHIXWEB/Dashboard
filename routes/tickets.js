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

    const all = await db.all('tickets');

    // An employee's visibility depends on the collaborator table, which
    // canView reads one ticket at a time. Read it once here instead: the list
    // used to run a full scan of ticket_collaborators per ticket on the page.
    if (req.user.role === 'employee') {
      const mine = await db.filter('ticket_collaborators', (c) => c.userId === req.user.id);
      const onTickets = new Set(mine.map((c) => c.ticketId));
      return res.json({
        tickets: all.filter((t) => t.assigneeId === req.user.id || onTickets.has(t.id)),
      });
    }

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

router.post('/', requireCSRF, async (req, res, next) => {
  try {
    const { subject, category, description } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const clientId = req.user.role === 'client' ? req.user.id : req.body.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const allTickets = await db.all('tickets');
    const numbers = allTickets
      .map((t) => parseInt(String(t.id).replace('ticket-', ''), 10))
      .filter((n) => !isNaN(n));
    const nextNumber = (numbers.length ? Math.max(...numbers) : 1000) + 1;

    const priority = intake.normalizePriority(req.body.priority);
    const ticket = await db.insert('tickets', {
      id: `ticket-${nextNumber}`,
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

    res.status(201).json({ ticket: routed });
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
