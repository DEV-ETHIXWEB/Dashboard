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

router.get('/', async (req, res, next) => {
  try {
    const all = await db.all('tickets');
    res.json({ tickets: all.filter((t) => visibleTo(req.user, t)) });
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

    const ticket = await db.insert('tickets', {
      subject, category: category || 'General', clientId, assigneeId: null,
      status: 'Open', description: description || '', createdAt: new Date().toISOString(),
    });
    await audit(req.user.id, 'create', 'ticket', ticket.id);

    const staff = await db.filter('users', (u) => ['admin', 'project_manager'].includes(u.role));
    for (const u of staff) await notify(u.id, `New ticket: "${subject}"`, 'ticket');

    res.status(201).json({ ticket });
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

    const updated = await db.update('tickets', req.params.id, patch);
    await audit(req.user.id, 'update', 'ticket', req.params.id);

    if (patch.status && patch.status !== ticket.status) {
      await notify(ticket.clientId, `Your ticket "${ticket.subject}" is now ${patch.status}`, 'ticket');
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

module.exports = router;
