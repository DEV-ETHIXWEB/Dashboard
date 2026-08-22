'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const { requirePage } = require('../utils/clientPages');

router.use(requireAuth);
router.use(requirePage('budget'));

function visibleTo(user, item) {
  if (['admin', 'sales', 'project_manager'].includes(user.role)) return true;
  if (user.role === 'client') return item.clientId === user.id;
  return false;
}

router.get('/', async (req, res, next) => {
  try {
    const all = await db.all('budget_items');
    let items = all.filter((i) => visibleTo(req.user, i));
    if (req.query.clientId) items = items.filter((i) => i.clientId === req.query.clientId);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const COLORS = ['#ff4438', '#ffb020', '#ff9d90', '#8fa8ff', '#35d68c', '#c2261b'];

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const { clientId, label, amount, month } = req.body || {};
    if (!clientId || !label || !amount) return res.status(400).json({ error: 'clientId, label, and amount are required' });

    const existing = await db.filter('budget_items', (i) => i.clientId === clientId);
    const color = COLORS[existing.length % COLORS.length];
    const thisMonth = month || new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    const item = await db.insert('budget_items', { clientId, label, amount: Number(amount), color, month: thisMonth });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [clientId];

    await audit(req.user.id, 'create', 'budget_item', item.id);
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const ok = await db.remove('budget_items', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Budget item not found' });
    await audit(req.user.id, 'delete', 'budget_item', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
