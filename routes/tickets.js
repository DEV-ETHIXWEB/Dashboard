'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');

router.use(requireAuth);

function visibleTo(user, ticket) {
  if (['admin', 'sales', 'project_manager'].includes(user.role)) return true;
  if (user.role === 'employee') return ticket.assigneeId === user.id;
  if (user.role === 'client') return ticket.clientId === user.id;
  return false;
}

router.get('/', (req, res) => {
  const tickets = db.all('tickets').filter((t) => visibleTo(req.user, t));
  res.json({ tickets });
});

router.post('/', requireCSRF, (req, res) => {
  const { subject, category, description } = req.body || {};
  if (!subject) return res.status(400).json({ error: 'subject is required' });

  const clientId = req.user.role === 'client' ? req.user.id : req.body.clientId;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  const ticket = db.insert('tickets', {
    subject, category: category || 'General', clientId, assigneeId: null,
    status: 'Open', description: description || '', createdAt: new Date().toISOString(),
  });
  audit(req.user.id, 'create', 'ticket', ticket.id);

  db.filter('users', (u) => ['admin', 'project_manager'].includes(u.role))
    .forEach((u) => notify(u.id, `New ticket: "${subject}"`, 'ticket'));

  res.status(201).json({ ticket });
});

router.put('/:id', requireCSRF, (req, res) => {
  const ticket = db.find('tickets', req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const isStaff = ['admin', 'project_manager', 'employee'].includes(req.user.role);
  const isOwner = req.user.role === 'client' && ticket.clientId === req.user.id;
  if (!isStaff && !isOwner) return res.status(403).json({ error: 'Not allowed to edit this ticket' });

  // Clients may only add detail via description; staff can change status/assignee too.
  const patch = isStaff ? { ...req.body } : { description: req.body.description };
  delete patch.id;

  const updated = db.update('tickets', req.params.id, patch);
  audit(req.user.id, 'update', 'ticket', req.params.id);

  if (patch.status && patch.status !== ticket.status) {
    notify(ticket.clientId, `Your ticket "${ticket.subject}" is now ${patch.status}`, 'ticket');
  }
  if (patch.assigneeId && patch.assigneeId !== ticket.assigneeId) {
    notify(patch.assigneeId, `You were assigned ticket: "${ticket.subject}"`, 'ticket');
  }
  res.json({ ticket: updated });
});

router.delete('/:id', requireCSRF, requireRole('admin'), (req, res) => {
  const ok = db.remove('tickets', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Ticket not found' });
  audit(req.user.id, 'delete', 'ticket', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
