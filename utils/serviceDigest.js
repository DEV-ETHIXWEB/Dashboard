'use strict';

/**
 * The monthly summaries: ads, search, assistant, accessibility.
 *
 * Four of the twenty-two services have a story worth telling unprompted every
 * month. The rest would be sending "nothing changed" twelve times a year, which
 * is how a client learns to ignore everything we send, so they are not in
 * UPDATE_BY_SERVICE and this file never looks at them.
 *
 * Scheduling follows the pattern the rest of this app already uses, for the
 * same reason: nothing in this process is alive between requests on serverless,
 * so a background timer is not a scheduler. There are two ways in instead --
 * a cron hitting the endpoint in routes/mail.js, and an admin running it by
 * hand -- and both land on `runSweep` below.
 *
 * The month is the unit. A client gets at most one of each summary per calendar
 * month however many times the sweep runs, which is what makes it safe to point
 * a daily cron at it and never think about the schedule again.
 */

const { db } = require('../db/setup');
const mailer = require('./mailer');
const service = require('./serviceEmails');
const launch = require('./serviceLaunch');

/** Floor between sweeps, so a busy admin session cannot hammer the database. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How late in the month a summary may still be sent.
 *
 * A summary of last month that lands on the 28th is not a summary, it is an
 * apology. The cron is expected to run daily and catch the 1st; this window is
 * what stops a deployment that was down for a fortnight from sending a stale
 * one the moment it comes back.
 */
const LATEST_DAY_OF_MONTH = 10;

let lastSweepAt = 0;
let inFlight = null;

/** "2026-10". The dedupe unit, and what makes a re-run free. */
function periodKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** "last month", spelled the way the templates expect to say it. */
function periodLabel(now = new Date()) {
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return previous.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/**
 * Projects that are live and carry a service with a monthly summary.
 *
 * Live is the condition that matters: a campaign still being built has nothing
 * to report, and a client who gets a performance summary for work that has not
 * started yet learns that our numbers are decorative.
 */
async function dueProjects() {
  return db.filter(
    'projects',
    (p) => Boolean(p.service)
      && Boolean(service.UPDATE_BY_SERVICE[p.service])
      && launch.isLaunched(p.status),
  );
}

/**
 * One summary per client per template per month.
 *
 * A client running Google Ads and Meta Ads has two live projects that both map
 * to the ads summary, and they want one email about their advertising, not two.
 * Grouping on (client, template) rather than on the project is the whole reason
 * this returns a map instead of iterating the list.
 */
function groupByRecipient(projects) {
  const groups = new Map();
  for (const project of projects) {
    if (!project.clientId) continue;
    const planned = service.UPDATE_BY_SERVICE[project.service];
    const id = `${project.clientId}|${planned.key}`;
    const existing = groups.get(id);
    if (existing) {
      existing.projects.push(project);
    } else {
      groups.set(id, { clientId: project.clientId, template: planned.key, projects: [project] });
    }
  }
  return [...groups.values()];
}

/** Whether this client already had this summary for this month. */
async function alreadySent(template, clientId, period) {
  const entityId = `${clientId}:${period}`;
  const rows = await db.filter(
    'email_log',
    (e) => e.template === template && e.entityId === entityId,
  );
  return rows.length > 0;
}

/**
 * The figures a summary reports.
 *
 * There is no metrics store in this app yet, so what the templates get is
 * whatever the project's own `service_context` carries. That is deliberate and
 * it is the seam: when ads and search numbers do land somewhere queryable, this
 * is the one function that changes, and the thirty-one templates, the
 * scheduling, the grouping and the dedupe all stay as they are.
 *
 * The templates drop any figure they are not given, so a summary with no
 * numbers is a shorter email rather than a broken one.
 */
function metricsFor(projects) {
  return projects.reduce((all, p) => ({ ...all, ...launch.parseContext(p.serviceContext) }), {});
}

/** Send one group's summary. Returns what it did; never throws. */
async function sendOne(group, { now = new Date(), force = false } = {}) {
  const period = periodKey(now);
  if (!force && (await alreadySent(group.template, group.clientId, period))) {
    return { sent: false, reason: 'already sent this month' };
  }

  const client = await db.find('users', group.clientId);
  if (!client || !client.email) return { sent: false, reason: 'no client email' };

  // Every project in the group maps to the same template, so any of their
  // service keys builds the same message. The first one is as good as any.
  const built = service.updateFor(group.projects[0].service, {
    ...metricsFor(group.projects),
    clientName: client.name || null,
    period: periodLabel(now),
  });
  if (!built) return { sent: false, reason: 'no summary for that service' };

  await mailer.sendTemplate({
    to: client.email,
    message: built.message,
    template: built.template,
    entity: 'client',
    // The client and the month together, so the log row reads as "David's ads
    // summary for October" and the dedupe check above can find it again.
    entityId: `${group.clientId}:${period}`,
    dedupeKey: `digest:${built.template}:${group.clientId}:${period}`,
  });

  return { sent: true, template: built.template, to: client.email };
}

/**
 * Run the sweep now. Returns what it looked at and what it acted on.
 *
 * `force` is for an admin re-sending on purpose and skips both the day-of-month
 * window and the already-sent check. The cron never passes it.
 */
async function runSweep({ now = new Date(), force = false } = {}) {
  if (!force && now.getDate() > LATEST_DAY_OF_MONTH) {
    return { skipped: 'too late in the month', considered: 0, sent: 0 };
  }

  const projects = await dueProjects();
  const groups = groupByRecipient(projects);

  let sent = 0;
  const failures = [];
  for (const group of groups) {
    try {
      const result = await sendOne(group, { now, force });
      if (result.sent) sent += 1;
    } catch (err) {
      // One client's summary failing is not a reason to skip everyone else's.
      failures.push({ clientId: group.clientId, template: group.template, error: err.message });
    }
  }

  lastSweepAt = Date.now();
  return { considered: groups.length, sent, failures };
}

/**
 * Run the sweep if it is due, riding on whatever request happened to arrive.
 *
 * Returns immediately when another sweep is already running or one ran
 * recently, so a busy dashboard cannot turn this into a queue of its own.
 */
async function maybeSweep() {
  if (inFlight) return inFlight;
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  inFlight = runSweep()
    .catch((err) => {
      console.error('The service summary sweep failed:', err.message);
      return null;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = {
  SWEEP_INTERVAL_MS,
  LATEST_DAY_OF_MONTH,
  periodKey,
  periodLabel,
  dueProjects,
  groupByRecipient,
  metricsFor,
  sendOne,
  runSweep,
  maybeSweep,
};
