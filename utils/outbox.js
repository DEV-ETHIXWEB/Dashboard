'use strict';

/**
 * The outbound queue.
 *
 * Every message this app sends used to be one attempt made inside the request
 * that caused it. SMTP2GO having a bad thirty seconds, Slack returning a 502,
 * Twilio timing out -- any of those and the message was simply gone. For email
 * there was at least a row in `email_log` saying 'failed', which nobody reads
 * until somebody complains; for Slack and SMS there was a line in the server
 * log and nothing else.
 *
 * So a send becomes a row here first, and a provider that is down for ten
 * minutes costs a delay instead of a message. Three things make that true:
 *
 *   - the row outlives the request, so there is something left to retry
 *   - `claimOutboxMessage` is atomic, so two sweeps cannot both send it
 *   - `dedupe_key` is UNIQUE, so a caller that runs twice queues once
 *
 * What this deliberately does NOT do is queue a secret. A sign-in code retried
 * half an hour later has expired; an activation link sitting in `payload` for
 * six hours is a live credential at rest in a table several people can read.
 * utils/mailer.js names those templates and sends them inline instead, where
 * the caller finds out immediately and a person is still watching. Reliability
 * for them comes from transport failover, not from retrying.
 *
 * Shaped like utils/credentialScheduler.js, which solved the same problem for
 * one message type before this existed: a throttled sweep ordinary traffic can
 * drive on a platform with no long-lived process, a real timer for one that
 * has, and a cron for the hours when nobody is using the app.
 */

const { v4: uuidv4 } = require('uuid');

const { db } = require('../db/setup');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const CHANNELS = ['email', 'sms', 'slack'];
const STATUSES = ['queued', 'sending', 'sent', 'failed', 'cancelled'];

/** Postgres' unique-violation code. The Firestore driver restamps onto it. */
const UNIQUE_VIOLATION = '23505';

/**
 * How long to wait before each retry, indexed by attempts already made.
 *
 * The first is short because most failures are a blip and a minute is not a
 * delay anybody notices. The last is long because by the fifth attempt the
 * problem is a wrong API key or an unverified sending domain, and hammering it
 * every minute for six hours just buries the real error under identical rows.
 *
 * Five attempts spread over roughly nine hours: long enough to ride out a
 * provider incident, short enough that a message still arrives the same day or
 * is escalated to a human.
 */
const BACKOFF_MS = [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS];

const DEFAULT_MAX_ATTEMPTS = 5;

/** A claim older than this belonged to a process that died mid-send. */
const STALE_CLAIM_MS = 15 * MINUTE_MS;

/** How long a delivered row is kept before `prune` throws it away. */
const SENT_RETENTION_MS = 7 * DAY_MS;

/** Floor between sweeps, so a busy dashboard cannot hammer the database. */
const SWEEP_INTERVAL_MS = MINUTE_MS;

/** How often an armed timer looks, on a deployment that keeps a process alive. */
const TIMER_INTERVAL_MS = 2 * MINUTE_MS;

/** Most rows one sweep will take, so a backlog cannot outrun a cron window. */
const SWEEP_BATCH = 50;

let lastSweepAt = 0;
let inFlight = null;
let timer = null;

/**
 * A failure that will never come good, however many times it is tried.
 *
 * The distinction matters more than it looks. Retrying a transient error is
 * the entire point of this file; retrying a permanent one wastes nine hours
 * before telling anybody, and the person who needed the message finds out a
 * day late that it was never going to arrive. So a send that fails for a
 * reason inherent to the message -- not to the moment -- gives up at once and
 * raises it.
 */
class PermanentFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentFailure';
    this.permanent = true;
  }
}

/**
 * Whether a provider's complaint is about this message or about this moment.
 *
 * Read conservatively on purpose: anything not recognised is treated as
 * transient and retried. Giving up on a message that would have gone through
 * is the worse mistake of the two, and the attempt ceiling stops an
 * unrecognised permanent failure from retrying for ever anyway.
 */
function isPermanent(err) {
  if (err && err.permanent) return true;

  const text = String((err && err.message) || err || '');

  // The caller asked for something impossible. No provider will ever accept it.
  if (/no valid recipients|cannot be empty|no such|not a client account|has no phone number/i.test(text)) return true;
  // Authentication and authorisation. A retry sends the same wrong key.
  if (/unauthor|invalid[_ ]?auth|not[_ ]?authed|invalid api key|refused our credentials/i.test(text)) return true;
  // The sending identity is not allowed, which is configuration, not weather.
  if (/domain is not verified|sender[^.]*(not allowed|denied)|will not send as this address/i.test(text)) return true;
  // Twilio 30034: the number is not registered for A2P. Never fixed by retrying.
  if (/\b30034\b|not registered for a2p/i.test(text)) return true;
  // Slack told us the channel or the recipient does not exist.
  if (/channel_not_found|user_not_found|is_archived|no_text/i.test(text)) return true;

  return false;
}

// --- putting something in --------------------------------------------------

/**
 * Queue one message.
 *
 * Returns the row, or the existing row when `dedupeKey` has already been used.
 * Callers do not have to care which: both mean "this message is somebody's
 * responsibility now".
 *
 * `payload` must be JSON-serialisable and must not contain a secret. There is
 * no way for this function to check the second part, so the rule lives where
 * it can be enforced -- utils/mailer.js refuses to queue the templates that
 * carry one, and sends them inline instead.
 */
async function enqueue({
  channel,
  payload,
  dedupeKey = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  entity = null,
  entityId = null,
  sendAt = null,
}) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown outbox channel "${channel}".`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('An outbox message needs a payload object.');
  }

  const now = new Date().toISOString();
  const row = {
    id: uuidv4(),
    channel,
    status: 'queued',
    dedupeKey: dedupeKey ? String(dedupeKey).slice(0, 200) : null,
    payload,
    attempts: 0,
    maxAttempts: Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS),
    // A message with no requested time is due now. One with a time in the past
    // is also due now, which is what a caller scheduling "9am" at 9:01 meant.
    nextAttemptAt: Math.max(Number(sendAt) || 0, Date.now()),
    entity,
    entityId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    return await db.insert('outbox', row);
  } catch (err) {
    // The dedupe key was taken, which is the index doing its job rather than
    // an error: somebody already queued this. Hand back what is already there.
    if (err && err.code === UNIQUE_VIOLATION && row.dedupeKey) {
      const existing = await findByDedupeKey(row.dedupeKey);
      if (existing) return existing;
    }
    throw err;
  }
}

/** The row holding a dedupe key, if one does. */
async function findByDedupeKey(dedupeKey) {
  const rows = await db.filter('outbox', (r) => r.dedupeKey === dedupeKey);
  return rows[0] || null;
}

// --- getting it out again --------------------------------------------------

/**
 * The handlers that actually talk to a provider.
 *
 * Required lazily, each inside its own case, so that requiring the outbox does
 * not drag in Slack, Twilio and nodemailer at once -- a deployment using none
 * of them should not pay for all three, and a test for the queue should not
 * need a mail transport to exist.
 *
 * Each returns the transport it used, for the row's record. Each throws on
 * failure, and throws `PermanentFailure` when it already knows a retry is
 * pointless.
 */
const handlers = {
  async email(payload) {
    const mailer = require('./mailer');
    const result = await mailer.sendNow(payload);
    if (!result.ok) {
      const message = result.error || result.skipped || 'The email could not be sent.';
      throw result.permanent ? new PermanentFailure(message) : new Error(message);
    }
    return result.transport || 'email';
  },

  async sms(payload) {
    const twilio = require('./twilio');
    const result = await twilio.sendSmsResult({ to: payload.to, body: payload.body });
    if (!result.ok) {
      throw result.permanent ? new PermanentFailure(result.error) : new Error(result.error);
    }

    // A text sent from the dashboard already has a row in `sms_messages`,
    // written before this retry so the thread showed the reply immediately.
    // Finishing that row is what turns it from "waiting" into "sent" on the
    // page -- without this, a retry that worked would leave the conversation
    // claiming the message never went.
    if (payload.messageId) {
      try {
        await db.update('sms_messages', payload.messageId, {
          providerSid: result.sid || null,
          deliveryStatus: 'sent',
          deliveryError: null,
        });
        require('./liveBus').publish('sms');
      } catch (err) {
        // The text is out. Failing the queue row now would send it twice,
        // which is worse than a row that reads as pending until the status
        // callback catches up.
        console.error(`[outbox] sent ${payload.messageId} but could not update its row:`, err.message);
      }
    }
    return 'twilio';
  },

  async slack(payload) {
    const slack = require('./slack');
    await slack.postMessage({
      channelId: payload.channelId,
      text: payload.text,
      threadTs: payload.threadTs || undefined,
    });
    return 'slack';
  },
};

/**
 * Carry out one queued message, exactly once.
 *
 * The claim is the whole story, exactly as it is in utils/credentialDelivery.js:
 * two sweeps both see this row, both call claim, and only one gets it back.
 */
async function deliver(id) {
  const claimed = await db.claimOutboxMessage(id);
  if (!claimed) return { skipped: true, reason: 'already claimed or no longer queued' };

  const now = new Date().toISOString();

  // The payload did not survive the round trip -- see rowToCamel in db/setup.js,
  // which hands back null rather than a half-parsed object. Nothing can be sent
  // from that, and no number of retries will repair it.
  if (!claimed.payload) {
    return failRow(claimed, new PermanentFailure('The queued message could not be read back.'));
  }

  const handler = handlers[claimed.channel];
  if (!handler) {
    return failRow(claimed, new PermanentFailure(`No handler for channel "${claimed.channel}".`));
  }

  try {
    const transport = await handler(claimed.payload);
    const sent = await db.update('outbox', claimed.id, {
      status: 'sent',
      sentAt: Date.now(),
      transport,
      lastError: null,
      updatedAt: now,
    });
    return { sent: true, row: sent };
  } catch (err) {
    return failRow(claimed, err);
  }
}

/** Back into the queue with a delay, or park it and tell the administrators. */
async function failRow(claimed, err) {
  const now = new Date().toISOString();
  const attempts = Number(claimed.attempts || 1);
  const maxAttempts = Number(claimed.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  const message = String((err && err.message) || err);
  const permanent = isPermanent(err);

  if (!permanent && attempts < maxAttempts) {
    const backoff = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    const retried = await db.update('outbox', claimed.id, {
      status: 'queued',
      nextAttemptAt: Date.now() + backoff,
      claimedAt: null,
      lastError: message,
      updatedAt: now,
    });
    console.warn(
      `[outbox] ${claimed.channel} message ${claimed.id} failed (attempt ${attempts}/${maxAttempts}), `
      + `retrying in ${Math.round(backoff / MINUTE_MS)}m: ${message}`,
    );
    return { retrying: true, row: retried, error: message };
  }

  const failed = await db.update('outbox', claimed.id, {
    status: 'failed',
    claimedAt: null,
    lastError: message,
    updatedAt: now,
  });
  console.error(
    `[outbox] ${claimed.channel} message ${claimed.id} gave up after ${attempts} attempt(s)`
    + `${permanent ? ' (permanent)' : ''}: ${message}`,
  );
  await raise(failed, message, permanent);
  return { failed: true, row: failed, error: message, permanent };
}

/**
 * Tell somebody a message is never arriving.
 *
 * Sent inline rather than queued, and that is not an oversight: a dead mail
 * transport is the most likely reason to be here, and queueing the alert about
 * it behind the same transport would put the only warning anybody gets at the
 * back of the queue that is already broken. Best-effort for the same reason --
 * if this fails too there is nothing further to try, and the console line
 * above has already been written.
 */
async function raise(row, message, permanent) {
  try {
    const admins = require('./admins');
    await admins.notifyAdmins(
      `A ${row.channel} message could not be delivered after ${row.attempts} attempt(s)`
      + `${permanent ? ' and will not be retried' : ''}: ${message}`,
      'security',
    );
  } catch (err) {
    console.error('[outbox] could not raise the delivery failure:', err.message);
  }
}

/** Put a failed message back in the queue, due immediately. */
async function requeue(id) {
  const row = await db.find('outbox', id);
  if (!row) throw new Error('No such queued message.');
  if (row.status === 'sent') throw new Error('That message already went out.');
  if (row.status === 'sending' && Date.now() - Number(row.claimedAt || 0) < STALE_CLAIM_MS) {
    throw new Error('That message is being sent right now.');
  }
  return db.update('outbox', id, {
    status: 'queued',
    nextAttemptAt: Date.now(),
    // A hand retry is a fresh start, not the sixth of five attempts.
    attempts: 0,
    claimedAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  });
}

// --- the sweep -------------------------------------------------------------

/**
 * Run the sweep now. Returns what it looked at and what it acted on.
 *
 * Never throws for one bad message: a single unreachable provider must not
 * stop the other forty-nine from going out.
 */
async function runSweep() {
  lastSweepAt = Date.now();

  const released = await db.releaseStaleOutboxClaims(STALE_CLAIM_MS);
  if (released.length > 0) {
    console.warn(`[outbox] released ${released.length} stale claim(s) back to the queue`);
  }

  const due = await db.dueOutboxMessages(Date.now(), SWEEP_BATCH);
  let sent = 0;
  let failed = 0;
  let retrying = 0;
  let skipped = 0;

  for (const row of due) {
    try {
      const result = await deliver(row.id);
      if (result.sent) sent += 1;
      else if (result.failed) failed += 1;
      else if (result.retrying) retrying += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(`[outbox] message ${row.id} threw:`, err.message);
    }
  }

  return { due: due.length, sent, failed, retrying, skipped, released: released.length };
}

/**
 * Run at most once per interval, and never twice at the same time. Safe to
 * call from a request handler without awaiting.
 */
async function maybeSweep() {
  if (inFlight) return inFlight;
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  inFlight = runSweep()
    .catch((err) => {
      console.error('The outbox sweep failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Arm a real timer, for a deployment that keeps a process alive.
 *
 * `unref` so it can never hold the process open on its own, and called only
 * from the `require.main === module` branch of server.js so that importing the
 * app -- serverless, tests -- never starts a timer nobody asked for.
 */
function startTimer() {
  if (timer) return timer;
  if (String(process.env.OUTBOX_TIMER || '').toLowerCase() === 'off') return null;

  timer = setInterval(() => {
    runSweep().catch((err) => console.error('The scheduled outbox sweep failed:', err.message));
  }, TIMER_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Throw away delivered rows nobody is coming back for. Failures are kept. */
async function prune() {
  try {
    return await db.pruneOutbox(Date.now() - SENT_RETENTION_MS);
  } catch (err) {
    console.error('[outbox] could not prune delivered rows:', err.message);
    return 0;
  }
}

/** What the queue looks like right now, for an admin asking "is mail stuck?". */
async function summary() {
  const rows = await db.filter('outbox', () => true);
  const counts = { queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
  let oldestQueuedAt = null;
  for (const row of rows) {
    if (row.status in counts) counts[row.status] += 1;
    if (row.status === 'queued') {
      const at = Number(row.createdAt ? Date.parse(row.createdAt) : 0) || null;
      if (at && (!oldestQueuedAt || at < oldestQueuedAt)) oldestQueuedAt = at;
    }
  }
  return { counts, oldestQueuedAt };
}

module.exports = {
  CHANNELS,
  STATUSES,
  BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  STALE_CLAIM_MS,
  SWEEP_INTERVAL_MS,
  TIMER_INTERVAL_MS,
  PermanentFailure,
  isPermanent,
  enqueue,
  deliver,
  requeue,
  runSweep,
  maybeSweep,
  startTimer,
  stopTimer,
  prune,
  summary,
};
