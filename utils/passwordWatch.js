'use strict';

/**
 * The monthly password rotation, run by the server rather than by a browser.
 *
 * Two jobs, in one pass over the accounts:
 *
 *   warn      a few days out, while changing it is still the person's choice
 *   require   once it has aged out: raise the flag and email a reset link
 *
 * Same shape as utils/domainWatch.js, including the trick that makes it safe to
 * run as often as anybody likes: **the email log is the record of what was
 * sent.** A warning is keyed by the account *and the expiry it was about*, so
 * running the sweep six times in an hour sends one email, and a password that
 * gets changed starts a fresh cycle with a fresh key rather than going quiet
 * for ever. No extra column, and a restart cannot cause a second warning.
 *
 * Nothing here ever sees a password. It reads a timestamp, writes a flag, and
 * emails a link that sets a secret it will never learn.
 */

const { db } = require('../db/setup');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const policy = require('./passwordPolicy');
const passwordTokens = require('./passwordTokens');
const live = require('./liveBus');
const { baseUrl } = require('./appUrl');
const { v4: uuidv4 } = require('uuid');

const MINUTE_MS = 60 * 1000;

/** Floor between sweeps. The policy moves in days; hourly is already generous. */
const SWEEP_INTERVAL_MS = 60 * MINUTE_MS;

/** How often an armed timer looks, on a deployment that keeps a process alive. */
const TIMER_INTERVAL_MS = 6 * 60 * MINUTE_MS;

let lastSweepAt = 0;
let inFlight = null;
let timer = null;

/**
 * What makes a warning unique: this account, and the expiry it was about.
 *
 * Including the expiry is what lets a changed password start a new cycle. The
 * old key never matches again, so next month's warning is not mistaken for one
 * that already went out.
 */
function warningKey(user, expiresAt) {
  return `${user.id}#${expiresAt}`;
}

async function alreadyEmailed(template, key) {
  const rows = await db.filter(
    'email_log',
    (e) => e.template === template && e.entityId === key && e.status !== 'failed',
  );
  return rows.length > 0;
}

/** An account the policy applies to at all. */
function inScope(user) {
  if (!user || !user.email) return false;
  // Nothing to rotate: this account proves itself to Google, not to us.
  if (!user.password) return false;
  return true;
}

/** Mint a reset link for this account, or null when there is nowhere to point it. */
async function resetUrlFor(user, purpose = 'reset') {
  const base = baseUrl();
  if (!base) return null;
  try {
    const { path, expiresAt } = await passwordTokens.issueFor(user, { purpose });
    return { url: `${base}${path}`, expiresAt };
  } catch (err) {
    console.error(`Could not mint a password reset link for ${user.id}:`, err.message);
    return null;
  }
}

/** The gentle one: your password is due soon. */
async function warn(user, expiresAt, daysLeft) {
  const key = warningKey(user, expiresAt);
  if (await alreadyEmailed('password_expiring', key)) return false;

  const link = await resetUrlFor(user);
  const result = await mailer.sendTemplate({
    to: user.email,
    message: messages.passwordExpiring({
      user,
      daysLeft,
      expiresAt,
      resetUrl: link ? link.url : null,
    }),
    template: 'password_expiring',
    entity: 'user',
    // The key, not the bare user id: this is what makes the send once-only per
    // cycle rather than once ever.
    entityId: key,
  });
  return Boolean(result.ok);
}

/**
 * The firm one: it has aged out.
 *
 * The flag goes up first and the email second. That order matters -- a flag
 * raised without an email leaves someone who has to ask an admin for a link,
 * which is recoverable; an email sent without the flag tells someone their
 * password expired when it has not, which is a support ticket and a lie.
 */
async function require_(user, expiresAt) {
  const key = warningKey(user, expiresAt);

  if (!policy.flag(user.passwordResetRequired)) {
    await db.update('users', user.id, { passwordResetRequired: true });
    await db.insert('activity_log', {
      id: uuidv4(),
      actorId: null,
      action: 'password_expired',
      entity: 'user',
      entityId: user.id,
      meta: { expiresAt, policyDays: policy.config().maxAgeDays, by: 'scheduled_job' },
      createdAt: new Date().toISOString(),
    });
    // Their open tabs re-read who they are and land on the change-password
    // screen rather than discovering it on their next click.
    live.publish('session', { to: [user.id] });
  }

  if (await alreadyEmailed('password_reset', key)) return false;

  const link = await resetUrlFor(user);
  if (!link) return false;

  const result = await mailer.sendTemplate({
    to: user.email,
    message: messages.passwordReset({
      user,
      resetUrl: link.url,
      expiresAt: link.expiresAt,
      required: true,
    }),
    template: 'password_reset',
    entity: 'user',
    entityId: key,
  });
  return Boolean(result.ok);
}

/** Run the sweep now. Returns what it looked at and what it acted on. */
async function runSweep() {
  lastSweepAt = Date.now();
  const cfg = policy.config();
  if (!cfg.enabled) return { checked: 0, warned: 0, required: 0, skipped: 'policy disabled' };

  const users = (await db.all('users')).filter(inScope);
  const now = Date.now();
  let warned = 0;
  let required = 0;

  for (const user of users) {
    try {
      const expiresAt = policy.expiresAt(user);
      if (expiresAt == null) continue;

      if (expiresAt <= now) {
        if (await require_(user, expiresAt)) required += 1;
        continue;
      }

      const daysLeft = Math.ceil((expiresAt - now) / policy.DAY_MS);
      if (daysLeft <= cfg.warnDays) {
        if (await warn(user, expiresAt, daysLeft)) warned += 1;
      }
    } catch (err) {
      console.error(`The password sweep could not process ${user.id}:`, err.message);
    }
  }

  if (required > 0) live.publish('users');
  return { checked: users.length, warned, required };
}

/** Run at most once per interval, and never twice at once. */
async function maybeSweep() {
  if (inFlight) return inFlight;
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  inFlight = runSweep()
    .catch((err) => {
      console.error('The password expiry sweep failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** See the note on credentialScheduler.startTimer -- same reasoning, same guards. */
function startTimer() {
  if (timer) return timer;
  if (String(process.env.PASSWORD_POLICY_TIMER || '').toLowerCase() === 'off') return null;

  timer = setInterval(() => {
    runSweep().catch((err) => console.error('The scheduled password sweep failed:', err.message));
  }, TIMER_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  runSweep,
  maybeSweep,
  startTimer,
  stopTimer,
  warningKey,
  inScope,
  SWEEP_INTERVAL_MS,
  TIMER_INTERVAL_MS,
};
