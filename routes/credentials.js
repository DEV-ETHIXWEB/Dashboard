'use strict';

/**
 * Scheduling when somebody is handed their login.
 *
 * Admin-only, top to bottom. The interesting boundary is not who may reach
 * these endpoints -- that is the same `requireRole('admin')` as everywhere
 * else -- but what an administrator gets back from them. A delivery record
 * says when an email is due, whether it went, and why it did not. It never
 * says what the account's password is, because nothing in this feature ever
 * knows: what is scheduled is a link that lets the account set its own.
 *
 * The work itself lives in utils/credentialDelivery.js (one delivery) and
 * utils/credentialScheduler.js (noticing they are due). This file is the API
 * surface and nothing else.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const roles = require('../utils/roles');
const delivery = require('../utils/credentialDelivery');
const scheduler = require('../utils/credentialScheduler');
const passwordWatch = require('../utils/passwordWatch');
const { credentialIssueLimiter, sensitiveAdminLimiter } = require('../utils/rateLimits');
const mailer = require('../utils/mailer');
const { baseUrl } = require('../utils/appUrl');

router.use(requireAuth, requireRole('admin'));

/** Turn a DeliveryError into its own status rather than a 500. */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof delivery.DeliveryError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  };
}

/**
 * Every delivery on record, with just enough of the account attached to render
 * a row without a second request.
 *
 * Loading a page is also the cue to sweep: a delivery that came due while
 * nobody was looking goes out now rather than waiting for a timer this
 * deployment may not have. Deliberately not awaited -- an admin opening a list
 * should not wait on an SMTP round trip.
 */
router.get('/', async (req, res, next) => {
  try {
    void scheduler.maybeSweep();

    const [rows, users] = await Promise.all([db.all('credential_deliveries'), db.all('users')]);
    const byId = new Map(users.map((u) => [u.id, u]));

    const deliveries = rows
      .sort((a, b) => Number(b.scheduledAt) - Number(a.scheduledAt))
      .map((row) => {
        const user = byId.get(row.userId);
        return {
          ...delivery.publicDelivery(row),
          userName: user ? user.name : 'Removed account',
          userEmail: user ? user.email : null,
          userRole: user ? user.role : null,
        };
      });

    // Two separate things can stop a delivery, and an admin needs to be told
    // which: no transport to send with, or no address to point the link at.
    res.json({
      deliveries,
      emailConfigured: mailer.isEnabled(),
      linkBaseConfigured: Boolean(baseUrl()),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Run both sweeps by hand.
 *
 * The manual counterpart to the traffic-driven pass, matching what the Mail
 * page already offers for the SLA and domain sweeps. Useful on a deployment
 * with no long-lived process, and useful for proving the thing works without
 * waiting an hour to find out.
 *
 * Declared above `POST /:userId` and it has to stay there: Express takes the
 * first route that matches, and `/run` is a perfectly good `:userId`.
 */
router.post('/run', requireCSRF, sensitiveAdminLimiter, async (req, res, next) => {
  try {
    const [credentials, passwords] = await Promise.all([
      scheduler.runSweep(),
      passwordWatch.runSweep(),
    ]);
    await audit(req.user.id, 'credential_sweep', 'system', null, { credentials, passwords });
    res.json({ credentials, passwords });
  } catch (err) {
    next(err);
  }
});

/**
 * Book a delivery for one account, or move the one already booked.
 *
 * `scheduledAt` is epoch milliseconds, the way every other timestamp in this
 * app travels. The browser converts from whatever the person picked in their
 * own timezone, so the server never has to guess one -- which is also why
 * there is no timezone setting to respect here: there has never been one, and
 * inventing it for this feature alone would put two answers in the codebase.
 */
router.post('/:userId', requireCSRF, credentialIssueLimiter, handle(async (req, res) => {
  const user = await db.find('users', req.params.userId);
  if (!user) return res.status(404).json({ error: 'No such user' });

  // Another administrator's credentials are a super admin's business, the same
  // rule PUT /api/users/:id applies to resetting one. Scheduling a link that
  // sets an admin password is the same power with a delay on it.
  if (user.role === 'admin' && user.id !== req.user.id && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can schedule credentials for another administrator.' });
  }

  const { delivery: row, rescheduled } = await delivery.schedule({
    user,
    scheduledAt: req.body?.scheduledAt,
    kind: req.body?.kind === 'reset' ? 'reset' : 'activation',
    actorId: req.user.id,
  });

  await audit(req.user.id, rescheduled ? 'credential_delivery_rescheduled' : 'credential_delivery_scheduled',
    'user', user.id, { deliveryId: row.id, scheduledAt: Number(row.scheduledAt), kind: row.kind });

  res.status(rescheduled ? 200 : 201).json({
    delivery: delivery.publicDelivery(row),
    rescheduled,
    emailConfigured: mailer.isEnabled(),
    linkBaseConfigured: Boolean(baseUrl()),
  });
}));

/** Call off a delivery that has not gone out yet. */
router.delete('/:userId', requireCSRF, handle(async (req, res) => {
  const user = await db.find('users', req.params.userId);
  if (!user) return res.status(404).json({ error: 'No such user' });

  if (user.role === 'admin' && user.id !== req.user.id && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can change another administrator’s credential delivery.' });
  }

  const row = await delivery.cancel({ user, actorId: req.user.id });
  await audit(req.user.id, 'credential_delivery_cancelled', 'user', user.id, { deliveryId: row.id });

  res.json({ delivery: delivery.publicDelivery(row) });
}));

/**
 * Send a failed delivery again.
 *
 * Its own endpoint rather than a flag on the schedule call, because it is a
 * different decision: rescheduling picks a new moment, retrying says "the
 * moment was right, the transport was not". Rate-limited with the sensitive
 * bucket -- a retry mints a fresh activation link every time it runs.
 */
router.post('/:deliveryId/retry', requireCSRF, sensitiveAdminLimiter, handle(async (req, res) => {
  const row = await db.find('credential_deliveries', req.params.deliveryId);
  if (!row) return res.status(404).json({ error: 'No such delivery' });

  const user = await db.find('users', row.userId);
  if (!user) return res.status(409).json({ error: 'That account no longer exists.' });
  if (user.role === 'admin' && user.id !== req.user.id && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can retry another administrator’s delivery.' });
  }

  await delivery.requeue({ deliveryId: row.id, actorId: req.user.id });
  await audit(req.user.id, 'credential_delivery_retried', 'user', user.id, { deliveryId: row.id });

  // Retry means now, so this one *is* awaited: the admin clicked a button and
  // is entitled to be told whether it worked.
  const result = await delivery.deliver(row.id);
  const after = await db.find('credential_deliveries', row.id);

  res.json({
    delivery: delivery.publicDelivery(after),
    sent: Boolean(result.sent),
    error: result.error || null,
  });
}));

module.exports = router;
