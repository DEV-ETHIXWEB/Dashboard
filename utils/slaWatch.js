'use strict';

/**
 * First-response deadlines that are about to be missed.
 *
 * There is no scheduler here on purpose: this app runs happily on serverless,
 * where background timers do not survive. Instead the sweep piggybacks on
 * traffic -- any ticket list request may trigger it, at most once every few
 * minutes -- and an admin can also run it on demand from the Mail page.
 *
 * A ticket is warned about once. The email log is the record of that, so no
 * extra column is needed and a restart cannot cause a second alert.
 */

const { db } = require('../db/setup');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const admins = require('./admins');
const intake = require('./ticketIntake');

const MINUTE_MS = 60 * 1000;

/** How close to the deadline counts as "warn now". */
const WARN_WINDOW_MS = 30 * MINUTE_MS;

/** Floor between sweeps, so a busy list page cannot hammer the database. */
const SWEEP_INTERVAL_MS = 5 * MINUTE_MS;

const OPEN_STATUSES = ['Open', 'In Progress'];

let lastSweepAt = 0;
let inFlight = null;

/** Tickets still waiting on a first response, inside the warning window. */
function needsWarning(ticket, now) {
  if (!OPEN_STATUSES.includes(ticket.status)) return false;
  if (!ticket.responseDueAt) return false;
  if (ticket.firstResponseAt) return false;
  return ticket.responseDueAt - now <= WARN_WINDOW_MS;
}

async function alreadyWarned(ticketId) {
  const rows = await db.filter(
    'email_log',
    (e) => e.template === 'sla_warning' && e.entityId === ticketId,
  );
  return rows.length > 0;
}

async function warn(ticket, now) {
  const [assignee, client] = await Promise.all([
    ticket.assigneeId ? db.find('users', ticket.assigneeId) : null,
    ticket.clientId ? db.find('users', ticket.clientId) : null,
  ]);

  const minutesLeft = Math.round((ticket.responseDueAt - now) / MINUTE_MS);
  const inboxes = await admins.adminEmails({ extra: assignee?.email ? [assignee.email] : [] });
  if (inboxes.length === 0) return false;

  await mailer.sendTemplate({
    to: inboxes,
    message: messages.slaWarning({
      ticket,
      assigneeName: assignee?.name || null,
      clientName: client?.name || null,
      minutesLeft,
    }),
    template: 'sla_warning',
    entity: 'ticket',
    entityId: ticket.id,
  });

  await admins.notifyAdmins(
    minutesLeft <= 0
      ? `Ticket "${ticket.subject}" is past its first-response deadline`
      : `Ticket "${ticket.subject}" needs a first response within ${minutesLeft} min`,
    'ticket',
  );

  await intake.echoActivity(
    ticket,
    minutesLeft <= 0
      ? `⏰ *${ticket.id}* is past its first-response deadline.`
      : `⏳ *${ticket.id}* needs a first response within ${minutesLeft} minutes.`,
  );

  return true;
}

/** Run the sweep now. Returns what it looked at and what it acted on. */
async function runSweep() {
  const now = Date.now();
  lastSweepAt = now;

  const tickets = await db.all('tickets');
  const due = tickets.filter((t) => needsWarning(t, now));

  let warned = 0;
  for (const ticket of due) {
    try {
      if (await alreadyWarned(ticket.id)) continue;
      if (await warn(ticket, now)) warned += 1;
    } catch (err) {
      console.error(`Could not send the response-due alert for ticket ${ticket.id}:`, err.message);
    }
  }

  return { checked: tickets.length, due: due.length, warned };
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
      console.error('The response-deadline sweep failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

module.exports = { runSweep, maybeSweep, needsWarning, WARN_WINDOW_MS, SWEEP_INTERVAL_MS };
