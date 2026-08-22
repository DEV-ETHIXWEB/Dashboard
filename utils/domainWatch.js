'use strict';

/**
 * Reminding a client that their website address is about to lapse.
 *
 * A domain expiring quietly is one of the few failures in this app that a
 * client cannot recover from afterwards: the address goes back on the market
 * and somebody else can take it. So the reminders start a month out, get more
 * frequent as the date approaches, and keep going for a week after it passes.
 *
 * No scheduler, for the same reason as utils/slaWatch.js: this app runs happily
 * on serverless, where background timers do not survive a cold start. The sweep
 * piggybacks on traffic -- any domain list request may trigger it, at most once
 * an hour -- and an admin can run it on demand.
 *
 * **Each reminder is sent exactly once.** The email log is the record: the key
 * carries the domain, the expiry date it was sent about, and which milestone it
 * was. Renewing the domain changes the expiry, which changes the key, which
 * starts a fresh series -- so a renewal quietly resets the reminders instead of
 * silencing them forever.
 */

const { db } = require('../db/setup');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const admins = require('./admins');
const live = require('./liveBus');
const { v4: uuidv4 } = require('uuid');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When to write, in days relative to the expiry date.
 *
 * Positive is before, zero is the day itself, negative is after. The shape is
 * deliberate: one early warning while renewing is still routine, a couple in
 * the week it matters, then daily-ish urgency, then two after the fact because
 * most registrars hold the name for a grace period and it can still be saved.
 */
const MILESTONES = [30, 14, 7, 3, 1, 0, -1, -7];

/** Floor between sweeps, so a busy list page cannot hammer the database. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt = 0;
let inFlight = null;

/**
 * The expiry as a calendar day, or null when the record has no usable date.
 *
 * Domains are stored with human dates like "Aug 23, 2026" as well as ISO
 * strings, depending on which screen wrote them, so both have to parse. Time of
 * day is dropped on purpose: "three days left" should not change because the
 * sweep ran at 9am rather than 5pm.
 */
function expiryDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function today() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Whole days from today until the domain lapses. Negative once it has. */
function daysUntil(domain, from = today()) {
  const day = expiryDay(domain.expiresAt);
  if (day == null) return null;
  return Math.round((day - from) / DAY_MS);
}

/**
 * The milestone this domain is standing on today, or null.
 *
 * Exact matches only, with one exception: a sweep that did not run for a few
 * days would otherwise skip straight past a milestone and never mention it. So
 * the *first* milestone at or below the days remaining is used, and the
 * once-only key stops the catch-up from sending the whole series at once.
 */
function milestoneFor(daysLeft) {
  if (daysLeft == null) return null;
  if (daysLeft > MILESTONES[0]) return null;
  if (daysLeft < MILESTONES[MILESTONES.length - 1]) return null;
  return MILESTONES.find((m) => daysLeft >= m) ?? null;
}

/**
 * What makes a reminder unique: this domain, this expiry date, this milestone.
 *
 * Including the expiry is what makes a renewal start a fresh series instead of
 * the domain going quiet forever.
 */
function reminderKey(domain, milestone) {
  return `${domain.id}#${expiryDay(domain.expiresAt)}#${milestone}`;
}

async function alreadySent(key) {
  const rows = await db.filter(
    'email_log',
    (e) => e.template === 'domain_expiring' && e.entityId === key,
  );
  return rows.length > 0;
}

/** Plain words for how long is left, used in the bell and the subject. */
function describeWindow(daysLeft) {
  if (daysLeft > 1) return `in ${daysLeft} days`;
  if (daysLeft === 1) return 'tomorrow';
  if (daysLeft === 0) return 'today';
  if (daysLeft === -1) return 'yesterday';
  return `${Math.abs(daysLeft)} days ago`;
}

/**
 * Write to the client who owns this domain, and put it in their bell.
 *
 * Admins are copied only once it is genuinely urgent -- a week out or already
 * lapsed. A monthly heads-up that pages the whole team teaches everyone to
 * ignore the alerts that matter.
 */
async function remind(domain, milestone, daysLeft) {
  const client = domain.clientId ? await db.find('users', domain.clientId) : null;
  const key = reminderKey(domain, milestone);
  const expired = daysLeft < 0;

  if (client?.email) {
    await mailer.sendTemplate({
      to: client.email,
      message: messages.domainExpiring({
        domain,
        clientName: client.name,
        daysLeft,
        window: describeWindow(daysLeft),
      }),
      template: 'domain_expiring',
      entity: 'domain',
      entityId: key,
    });

    await db.insert('notifications', {
      id: uuidv4(),
      userId: client.id,
      message: expired
        ? `${domain.domainName} expired ${describeWindow(daysLeft)}. It can still be renewed for a short while.`
        : `${domain.domainName} expires ${describeWindow(daysLeft)}.`,
      type: 'domain',
      read: false,
      createdAt: new Date().toISOString(),
    });
    live.publish('notifications', { to: [client.id] });
    live.publish('domains', { to: [client.id] });
  } else {
    // No client email means nobody outside this office can act on it, so the
    // record still has to exist -- otherwise the sweep retries it forever.
    await mailer.sendMail({
      to: await admins.adminEmails(),
      subject: `${domain.domainName} expires ${describeWindow(daysLeft)} (no client address on file)`,
      text: `${domain.domainName} expires ${describeWindow(daysLeft)} and has no client email address to warn.`,
      template: 'domain_expiring',
      entity: 'domain',
      entityId: key,
    });
  }

  if (daysLeft <= 7) {
    await admins.notifyAdmins(
      expired
        ? `${domain.domainName} expired ${describeWindow(daysLeft)}${client ? ` (${client.name})` : ''}`
        : `${domain.domainName} expires ${describeWindow(daysLeft)}${client ? ` (${client.name})` : ''}`,
      'domain',
    );
  }

  return true;
}

/** Run the sweep now. Returns what it looked at and what it acted on. */
async function runSweep() {
  const now = today();
  lastSweepAt = Date.now();

  const domains = await db.all('domains');
  const due = [];

  for (const domain of domains) {
    const daysLeft = daysUntil(domain, now);
    const milestone = milestoneFor(daysLeft);
    if (milestone == null) continue;
    due.push({ domain, milestone, daysLeft });
  }

  let sent = 0;
  let skipped = 0;
  for (const { domain, milestone, daysLeft } of due) {
    try {
      if (await alreadySent(reminderKey(domain, milestone))) {
        skipped += 1;
        continue;
      }
      if (await remind(domain, milestone, daysLeft)) sent += 1;
    } catch (err) {
      console.error(`Could not send the expiry reminder for ${domain.domainName}:`, err.message);
    }
  }

  return { checked: domains.length, due: due.length, sent, skipped };
}

/**
 * Run at most once an hour, and never twice at the same time. Safe to call from
 * a request handler without awaiting.
 */
async function maybeSweep() {
  if (inFlight) return inFlight;
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  inFlight = runSweep()
    .catch((err) => {
      console.error('The domain expiry sweep failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

module.exports = {
  MILESTONES,
  SWEEP_INTERVAL_MS,
  expiryDay,
  daysUntil,
  milestoneFor,
  reminderKey,
  describeWindow,
  runSweep,
  maybeSweep,
};
