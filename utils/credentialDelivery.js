'use strict';

/**
 * Handing someone their login, at a time somebody chose in advance.
 *
 * The reason this is not just "send the welcome email later": what goes out is
 * not a password. utils/userProvisioning.js emails one today, and that is
 * defensible when an admin is sitting there watching it happen and can read it
 * out if the mail bounces. A message scheduled for Tuesday morning has nobody
 * watching it. A password sitting unread in a mailbox for a week is a
 * credential with no owner, and the workspace has no way of knowing whether
 * anyone else has read it.
 *
 * So a scheduled delivery carries a single-use activation link instead
 * (utils/passwordTokens.js). The account chooses its own password, the sender
 * never learns it, and the link expires whether or not anybody used it.
 *
 * Exactly one delivery is ever pending per account. Rescheduling moves that
 * row; it does not queue a second one. That plus the atomic claim below is
 * what makes a duplicate credential email impossible rather than unlikely.
 */

const { v4: uuidv4 } = require('uuid');

const { db } = require('../db/setup');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const passwordTokens = require('./passwordTokens');
const policy = require('./passwordPolicy');
const admins = require('./admins');
const { baseUrl } = require('./appUrl');

const STATUSES = ['scheduled', 'sending', 'sent', 'failed', 'cancelled'];
const KINDS = ['activation', 'reset'];

/** Statuses that still owe somebody an email. */
const OPEN_STATUSES = ['scheduled', 'sending'];

/**
 * How many times a delivery tries before it gives up and asks for a human.
 *
 * Three, spaced out. A transient provider hiccup is over well inside that; a
 * misconfigured sending domain never recovers on its own, and retrying it
 * forever would just bury the real problem under identical log rows.
 */
const MAX_ATTEMPTS = 3;

/** Backoff between attempts, indexed by how many have already been made. */
const RETRY_BACKOFF_MS = [5 * 60 * 1000, 30 * 60 * 1000];

/**
 * A claim older than this belonged to a process that died mid-send.
 *
 * Generous on purpose: shorter than this and a slow SMTP handshake could be
 * mistaken for a dead worker, and the delivery would go out twice.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000;

class DeliveryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
  }
}

/** Whether an account can be handed a login at all. */
function eligibility(user) {
  if (!user) return 'No such user.';
  if (!user.email) return 'That account has no email address to send to.';
  if (user.googleId && !user.password) {
    return 'That account signs in with Google, so it has no password to set.';
  }
  return null;
}

/** The delivery still owed to this account, if there is one. */
async function pendingFor(userId) {
  const rows = await db.filter(
    'credential_deliveries',
    (row) => row.userId === userId && OPEN_STATUSES.includes(row.status),
  );
  return rows.sort((a, b) => Number(b.scheduledAt) - Number(a.scheduledAt))[0] || null;
}

/** Every delivery for one account, newest first. */
async function historyFor(userId) {
  const rows = await db.filter('credential_deliveries', (row) => row.userId === userId);
  return rows.sort((a, b) => Number(b.scheduledAt) - Number(a.scheduledAt));
}

/**
 * Turn whatever the admin picked into a usable moment.
 *
 * Epoch milliseconds, the way every other timestamp in this app travels, so
 * the browser sends a moment rather than a date string that the server would
 * then have to guess a timezone for. A date in the past is accepted and treated
 * as "now" -- an admin who picks 9am and submits at 9:01 meant send it, not
 * throw an error at me.
 */
function resolveScheduledAt(value) {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    throw new DeliveryError('Pick a date and time for the delivery.');
  }
  // A year out is not a schedule, it is a typo or a unit mix-up.
  const ceiling = Date.now() + 365 * policy.DAY_MS;
  if (asNumber > ceiling) {
    throw new DeliveryError('That is more than a year away. Pick a nearer date.');
  }
  return Math.max(asNumber, Date.now());
}

/**
 * Book a delivery, or move the one already booked.
 *
 * Returns `{ delivery, rescheduled }`. A row that has already gone out is never
 * touched: scheduling again after a send is a new delivery, deliberately, so
 * the record keeps both.
 */
async function schedule({ user, scheduledAt, kind = 'activation', actorId = null }) {
  const refusal = eligibility(user);
  if (refusal) throw new DeliveryError(refusal, 400);
  if (!KINDS.includes(kind)) throw new DeliveryError('Unknown delivery kind.');

  const when = resolveScheduledAt(scheduledAt);
  const now = new Date().toISOString();
  const existing = await pendingFor(user.id);

  if (existing) {
    // A row someone else is mid-send on must not be yanked out from under them.
    if (existing.status === 'sending' && Date.now() - Number(existing.claimedAt || 0) < STALE_CLAIM_MS) {
      throw new DeliveryError('That delivery is being sent right now. Try again in a moment.', 409);
    }
    const updated = await db.update('credential_deliveries', existing.id, {
      scheduledAt: when,
      kind,
      status: 'scheduled',
      claimedAt: null,
      lastError: null,
      updatedAt: now,
    });
    return { delivery: updated, rescheduled: true };
  }

  const delivery = await db.insert('credential_deliveries', {
    id: uuidv4(),
    userId: user.id,
    kind,
    status: 'scheduled',
    scheduledAt: when,
    attempts: 0,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  return { delivery, rescheduled: false };
}

/** Call off a delivery that has not gone out. */
async function cancel({ user, actorId = null }) {
  const existing = await pendingFor(user.id);
  if (!existing) throw new DeliveryError('There is no delivery waiting for that account.', 404);
  if (existing.status === 'sending' && Date.now() - Number(existing.claimedAt || 0) < STALE_CLAIM_MS) {
    throw new DeliveryError('That delivery is being sent right now and can no longer be cancelled.', 409);
  }
  return db.update('credential_deliveries', existing.id, {
    status: 'cancelled',
    cancelledAt: Date.now(),
    updatedAt: new Date().toISOString(),
    // Whoever cancelled it is in the audit log; this field stays as the
    // person who booked it, so the row still says who wanted it sent.
    lastError: null,
  });
}

/** Put a failed delivery back in the queue, due immediately. */
async function requeue({ deliveryId, actorId = null }) {
  const row = await db.find('credential_deliveries', deliveryId);
  if (!row) throw new DeliveryError('No such delivery.', 404);
  if (row.status === 'sent') throw new DeliveryError('That delivery already went out.', 409);
  if (row.status === 'sending' && Date.now() - Number(row.claimedAt || 0) < STALE_CLAIM_MS) {
    throw new DeliveryError('That delivery is being sent right now.', 409);
  }
  return db.update('credential_deliveries', deliveryId, {
    status: 'scheduled',
    scheduledAt: Date.now(),
    // A manual retry is a fresh start, not the fourth of three attempts.
    attempts: 0,
    claimedAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
    ...(actorId ? { createdBy: row.createdBy || actorId } : {}),
  });
}

/**
 * Mint the link and send it. Assumes the row is already claimed.
 *
 * The token is created here rather than when the delivery was booked, so its
 * clock starts when the email lands. A token minted on Monday for a Friday
 * delivery would arrive already half spent.
 */
async function sendFor(delivery, user) {
  const base = baseUrl();
  if (!base) {
    throw new Error(
      'No public address is configured, so the activation link would point nowhere. Set APP_BASE_URL.',
    );
  }

  const { path, expiresAt } = await passwordTokens.issueFor(user, {
    purpose: delivery.kind === 'reset' ? 'reset' : 'activation',
    issuedBy: delivery.createdBy || null,
  });

  const provisioning = require('./userProvisioning');
  const inviter = delivery.createdBy ? await db.find('users', delivery.createdBy) : null;

  const result = await mailer.sendTemplate({
    to: user.email,
    message: messages.accountActivation({
      user,
      activationUrl: `${base}${path}`,
      expiresAt,
      kind: delivery.kind,
      sections: user.role === 'client' ? provisioning.sectionLabels(user) : null,
      invitedBy: inviter ? inviter.name : null,
    }),
    template: 'account_activation',
    entity: 'user',
    entityId: user.id,
  });

  if (!result.ok) {
    throw new Error(result.error || result.skipped || 'The email could not be sent.');
  }
  return { expiresAt };
}

/**
 * Carry out one delivery, exactly once.
 *
 * The claim is the whole story: two sweeps running at the same moment both see
 * this row, both call claim, and only one of them gets it back. The other
 * returns `skipped` and touches nothing.
 */
async function deliver(deliveryId) {
  const claimed = await db.claimCredentialDelivery(deliveryId);
  if (!claimed) return { skipped: true, reason: 'already claimed or no longer scheduled' };

  const user = await db.find('users', claimed.userId);
  const now = new Date().toISOString();

  // The account went away between booking and sending. Not a failure worth
  // retrying or paging anyone about -- there is nobody to send to.
  if (!user) {
    await db.update('credential_deliveries', claimed.id, {
      status: 'cancelled',
      cancelledAt: Date.now(),
      lastError: 'The account no longer exists.',
      updatedAt: now,
    });
    return { skipped: true, reason: 'user removed' };
  }

  try {
    await sendFor(claimed, user);
    const sent = await db.update('credential_deliveries', claimed.id, {
      status: 'sent',
      sentAt: Date.now(),
      lastError: null,
      updatedAt: now,
    });
    await audit(claimed.createdBy, 'credential_delivery_sent', 'user', user.id, {
      deliveryId: claimed.id,
      kind: claimed.kind,
      attempts: claimed.attempts,
    });
    return { sent: true, delivery: sent };
  } catch (err) {
    return failDelivery(claimed, user, err);
  }
}

/** Back into the queue with a delay, or park it and tell the administrators. */
async function failDelivery(claimed, user, err) {
  const now = new Date().toISOString();
  const attempts = Number(claimed.attempts || 1);
  const message = String(err && err.message ? err.message : err);

  if (attempts < MAX_ATTEMPTS) {
    const backoff = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    const retried = await db.update('credential_deliveries', claimed.id, {
      status: 'scheduled',
      scheduledAt: Date.now() + backoff,
      claimedAt: null,
      lastError: message,
      updatedAt: now,
    });
    console.warn(`[credentials] delivery ${claimed.id} failed (attempt ${attempts}), retrying: ${message}`);
    return { retrying: true, delivery: retried, error: message };
  }

  const failed = await db.update('credential_deliveries', claimed.id, {
    status: 'failed',
    claimedAt: null,
    lastError: message,
    updatedAt: now,
  });

  // Nobody else finds out otherwise: the person who was meant to receive a
  // login simply never hears anything.
  try {
    const inboxes = await admins.adminEmails();
    if (inboxes.length > 0) {
      await mailer.sendTemplate({
        to: inboxes,
        message: messages.credentialDeliveryFailed({
          user,
          error: message,
          scheduledAt: Number(claimed.scheduledAt),
          attempts,
        }),
        template: 'credential_delivery_failed',
        entity: 'user',
        entityId: user.id,
      });
    }
    await admins.notifyAdmins(
      `Could not deliver ${user.name}'s login after ${attempts} attempts. Retry it from Client Access.`,
      'security',
    );
  } catch (notifyErr) {
    console.error('Could not raise the credential delivery failure:', notifyErr.message);
  }

  await audit(claimed.createdBy, 'credential_delivery_failed', 'user', user.id, {
    deliveryId: claimed.id,
    attempts,
    // The provider's own words. No token, no password -- neither is ever in
    // scope at this point, because the token was never minted or was discarded.
    error: message,
  });

  return { failed: true, delivery: failed, error: message };
}

/** Audit without importing the middleware, which would pull in half the app. */
async function audit(actorId, action, entity, entityId, meta) {
  try {
    await db.insert('activity_log', {
      id: uuidv4(),
      actorId: actorId || null,
      action,
      entity,
      entityId,
      meta: meta || null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Could not write the credential delivery audit row:', err.message);
  }
}

/**
 * The shape the dashboard reads.
 *
 * Never the token, never a password, never the row's internals beyond what an
 * admin needs to answer "did it go, and if not why not".
 */
function publicDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    // A row mid-send reads as scheduled to the outside world: "sending" is a
    // lock, not a state anybody needs to reason about.
    status: row.status === 'sending' ? 'scheduled' : row.status,
    scheduledAt: Number(row.scheduledAt) || null,
    sentAt: Number(row.sentAt) || null,
    cancelledAt: Number(row.cancelledAt) || null,
    attempts: Number(row.attempts || 0),
    lastAttemptAt: Number(row.lastAttemptAt) || null,
    lastError: row.lastError || null,
    canRetry: row.status === 'failed',
    createdBy: row.createdBy || null,
    createdAt: row.createdAt || null,
  };
}

module.exports = {
  STATUSES,
  KINDS,
  MAX_ATTEMPTS,
  STALE_CLAIM_MS,
  DeliveryError,
  eligibility,
  pendingFor,
  historyFor,
  resolveScheduledAt,
  schedule,
  cancel,
  requeue,
  deliver,
  publicDelivery,
};
