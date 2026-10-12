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

/** The longest a budget line's label may be. It is printed in a chart legend. */
const LABEL_MAX = 80;

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const { clientId, label, amount, month } = req.body || {};
    if (!clientId || !label || !amount) return res.status(400).json({ error: 'clientId, label, and amount are required' });

    /**
     * Each field checked, rather than taken on trust.
     *
     * `Number(amount)` on anything unparseable is NaN, which was written
     * straight to the row -- and NaN in a money column renders as "NaN" on a
     * client's budget chart and poisons every total it is added to. A negative
     * amount quietly subtracts from the budget it is supposed to describe. An
     * unbounded label is a chart legend somebody can ruin. And `clientId` was
     * never checked at all, so a budget line could be hung off a staff id, or
     * off nothing, and would then show on no page at all.
     */
    const client = await db.find('users', clientId);
    if (!client || client.role !== 'client') {
      return res.status(400).json({ error: 'clientId must reference a client account.' });
    }

    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'A label has to be some text.' });
    }
    const cleanLabel = label.trim();
    if (cleanLabel.length > LABEL_MAX) {
      return res.status(400).json({ error: `Keep a label under ${LABEL_MAX} characters.` });
    }

    const value = Number(amount);
    if (!Number.isFinite(value)) {
      return res.status(400).json({ error: 'An amount has to be a number.' });
    }
    if (value < 0) {
      return res.status(400).json({ error: 'An amount cannot be negative.' });
    }

    const existing = await db.filter('budget_items', (i) => i.clientId === clientId);
    const color = COLORS[existing.length % COLORS.length];
    const thisMonth = month || new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    const item = await db.insert('budget_items', {
      clientId, label: cleanLabel, amount: value, color, month: thisMonth,
    });
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
    // Read before the delete, because the client it belonged to is what tells
    // us whose open tabs to redraw -- and after the row is gone there is
    // nothing to ask. Without it the line vanished from the database and
    // stayed on the client's chart until they reloaded.
    const item = await db.find('budget_items', req.params.id);
    const ok = await db.remove('budget_items', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Budget item not found' });
    if (item?.clientId) res.locals.liveAudience = [item.clientId];
    await audit(req.user.id, 'delete', 'budget_item', req.params.id, { clientId: item?.clientId || null });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
