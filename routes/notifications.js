'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireCSRF } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', (req, res) => {
  const notifications = db.filter('notifications', (n) => n.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ notifications });
});

router.post('/read-all', requireCSRF, (req, res) => {
  const mine = db.filter('notifications', (n) => n.userId === req.user.id && !n.read);
  mine.forEach((n) => db.update('notifications', n.id, { read: true }));
  res.json({ ok: true, updated: mine.length });
});

router.patch('/:id/read', requireCSRF, (req, res) => {
  const n = db.find('notifications', req.params.id);
  if (!n || n.userId !== req.user.id) return res.status(404).json({ error: 'Notification not found' });
  const updated = db.update('notifications', req.params.id, { read: true });
  res.json({ notification: updated });
});

router.delete('/', requireCSRF, (req, res) => {
  const removed = db.removeWhere('notifications', (n) => n.userId === req.user.id);
  res.json({ ok: true, removed });
});

module.exports = router;
