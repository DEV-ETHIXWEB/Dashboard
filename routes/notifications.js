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
/**
 * How many notifications one page of the bell menu holds.
 *
 * The list returned every notification the account had ever received, which on
 * a busy workspace is thousands of rows crossing the wire so somebody can read
 * the newest five. Nothing in the UI shows the far end of that list.
 */
const PAGE_SIZE = 50;

/**
 * How long a read notification is kept.
 *
 * They were never pruned, so the table grew for ever -- and it is written to
 * on every ticket change, every plan change and every assignment, which makes
 * it the fastest-growing table in the application. A notification somebody
 * read three months ago is not something anybody goes back to.
 */
const KEEP_READ_DAYS = 90;

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(
      PAGE_SIZE,
      Math.max(1, Number.parseInt(String(req.query.limit || PAGE_SIZE), 10) || PAGE_SIZE),
    );

    const notifications = await db.where(
      'notifications', { userId: req.user.id }, { orderBy: 'createdAt', limit: limit + 1 },
    );

    // One extra row is asked for and not returned: its presence is how the
    // page knows there is more without a second count query.
    const hasMore = notifications.length > limit;

    res.json({
      notifications: hasMore ? notifications.slice(0, limit) : notifications,
      hasMore,
    });

    // Old read rows go on the way out, throttled, so nobody waits on it and
    // the table does not grow without bound. Deliberately after the response.
    void pruneRead(req.user.id);
  } catch (err) {
    next(err);
  }
});

/**
 * Throw away this account's long-read notifications.
 *
 * Per account rather than a global sweep, because it rides on a request that
 * already named one -- and because a global delete is a long transaction on
 * the biggest table here. Throttled per process so a page that polls does not
 * run it on every load. Never throws: this is housekeeping.
 */
let lastPrune = 0;

async function pruneRead(userId) {
  if (Date.now() - lastPrune < 60 * 60 * 1000) return;
  lastPrune = Date.now();
  try {
    const cutoff = new Date(Date.now() - KEEP_READ_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const mine = await db.where('notifications', { userId });
    for (const row of mine) {
      if (row.read && row.createdAt && String(row.createdAt) < cutoff) {
        await db.remove('notifications', row.id);
      }
    }
  } catch (err) {
    console.error(`[notifications] could not prune for ${userId}: ${err.message}`);
  }
}

router.post('/read-all', requireCSRF, async (req, res, next) => {
  try {
    // Narrowed to this user by the database, then `!read` in memory -- which
    // also catches a row whose flag was never set, where `read = false` in SQL
    // would not.
    const mine = (await db.where('notifications', { userId: req.user.id }))
      .filter((n) => !n.read);
    // In parallel, in batches. One `await` per row meant pressing "mark all
    // read" on a hundred notifications was a hundred sequential round trips,
    // and the button sat spinning for the length of all of them.
    const BATCH = 25;
    for (let i = 0; i < mine.length; i += BATCH) {
      await Promise.all(
        mine.slice(i, i + BATCH).map((n) => db.update('notifications', n.id, { read: true })),
      );
    }
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
