'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireCSRF } = require('../middleware/auth');

router.use(requireAuth);
// Open to every role: staff need to receive handover and collaboration
// requests. Each route below is already scoped to req.user.id, so a user can
// only ever read or change their own notifications.

router.get('/', async (req, res, next) => {
  try {
    const mine = await db.filter('notifications', (n) => n.userId === req.user.id);
    mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ notifications: mine });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', requireCSRF, async (req, res, next) => {
  try {
    const mine = await db.filter('notifications', (n) => n.userId === req.user.id && !n.read);
    for (const n of mine) await db.update('notifications', n.id, { read: true });
    res.json({ ok: true, updated: mine.length });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', requireCSRF, async (req, res, next) => {
  try {
    const n = await db.find('notifications', req.params.id);
    if (!n || n.userId !== req.user.id) return res.status(404).json({ error: 'Notification not found' });
    const updated = await db.update('notifications', req.params.id, { read: true });
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/', requireCSRF, async (req, res, next) => {
  try {
    const removed = await db.removeWhere('notifications', (n) => n.userId === req.user.id);
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
