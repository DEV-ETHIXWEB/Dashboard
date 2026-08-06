'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const clickup = require('../utils/clickup');
const workflow = require('../utils/ticketWorkflow');

router.use(requireAuth);

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

/**
 * Push a new ticket into ClickUp so the team works one queue instead of two.
 * Deliberately non-fatal: if ClickUp is unreachable or misconfigured, the
 * ticket still exists here and we just log the failure.
 */
async function mirrorToClickUp(ticket) {
  if (!clickup.isTicketMirroringEnabled()) return null;
  try {
    const client = ticket.clientId ? await db.find('users', ticket.clientId) : null;
    const task = await clickup.mirrorTicket(ticket, { clientName: client?.name });
    if (!task) return null;
    return db.update('tickets', ticket.id, { clickupTaskId: task.id, clickupTaskUrl: task.url });
  } catch (err) {
    console.error(`Could not mirror ticket ${ticket.id} to ClickUp:`, err.message);
    return null;
  }
}

/** Keep the mirrored ClickUp task in step when a ticket is closed or reopened. */
async function syncStatusToClickUp(ticket, status) {
  if (!ticket.clickupTaskId || !clickup.isEnabled()) return;
  try {
    await clickup.updateTask(ticket.clickupTaskId, {
      status: ['Resolved', 'Closed'].includes(status) ? 'complete' : 'to do',
    });
  } catch (err) {
    console.error(`Could not sync ticket ${ticket.id} status to ClickUp:`, err.message);
  }
}

router.get('/', async (req, res, next) => {
  try {
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

    const ticket = await db.insert('tickets', {
      id: `ticket-${nextNumber}`,
      subject, category: category || 'General', clientId, assigneeId: null,
      status: 'Open', description: description || '', createdAt: new Date().toISOString(),
    });
    await audit(req.user.id, 'create', 'ticket', ticket.id);

    const staff = await db.filter('users', (u) => ['admin', 'project_manager'].includes(u.role));
    for (const u of staff) await notify(u.id, `New ticket: "${subject}"`, 'ticket');

    const mirrored = await mirrorToClickUp(ticket);

    res.status(201).json({ ticket: mirrored || ticket });
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

    const patch = isStaff ? { ...req.body } : { description: req.body.description };
    delete patch.id;
    // The ClickUp link is owned by the mirroring code, never by the client.
    delete patch.clickupTaskId;
    delete patch.clickupTaskUrl;

    const updated = await db.update('tickets', req.params.id, patch);
    await audit(req.user.id, 'update', 'ticket', req.params.id);

    if (patch.status && patch.status !== ticket.status) {
      await notify(ticket.clientId, `Your ticket "${ticket.subject}" is now ${patch.status}`, 'ticket');
      await syncStatusToClickUp(ticket, patch.status);
    }
    if (patch.assigneeId && patch.assigneeId !== ticket.assigneeId) {
      await notify(patch.assigneeId, `You were assigned ticket: "${ticket.subject}"`, 'ticket');
    }
    res.json({ ticket: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
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
  const [updates, collaborators] = await Promise.all([
    workflow.listUpdates(req.ticket.id),
    workflow.listCollaborators(req.ticket.id),
  ]);
  res.json({
    ticket: req.ticket,
    updates,
    collaborators,
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
