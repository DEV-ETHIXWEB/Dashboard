'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireCSRF } = require('../middleware/auth');

router.use(requireAuth);
// Open to every role: staff need to receive handover and collaboration
// requests. Each route below is already scoped to req.user.id, so a user can
// only ever read or change their own notifications.

/**
 * Asked for by user, not filtered out of everybody's notifications in memory.
 *
 * This is read on every page the dashboard renders, so it is the single
 * hottest query in the application. Reading the whole table to find one
 * person's handful is the sort of thing that is invisible on a seeded
 * workspace and falls over on a real one.
 */
router.get('/', async (req, res, next) => {
  try {
    res.json({
      notifications: await db.where(
        'notifications', { userId: req.user.id }, { orderBy: 'createdAt' },
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', requireCSRF, async (req, res, next) => {
  try {
    // Narrowed to this user by the database, then `!read` in memory -- which
    // also catches a row whose flag was never set, where `read = false` in SQL
    // would not.
    const mine = (await db.where('notifications', { userId: req.user.id }))
      .filter((n) => !n.read);
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
    // Same reason as the reads above: find this user's rows by index rather
    // than reading everybody's to decide which are theirs.
    const mine = await db.where('notifications', { userId: req.user.id });
    for (const n of mine) await db.remove('notifications', n.id);
    res.json({ ok: true, removed: mine.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
