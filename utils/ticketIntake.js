'use strict';

/**
 * What happens the moment a ticket is raised: pick a priority, put a response
 * clock on it, give it an owner, and tell everyone who needs to know.
 *
 * Every side effect here is best-effort. A ticket that was saved must never be
 * reported as failed because Slack or email was down.
 */

const { db } = require('../db/setup');
const { notify } = require('../middleware/auth');
const slack = require('./slack');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const admins = require('./admins');
const clickup = require('./clickup');

const HOUR_MS = 60 * 60 * 1000;

const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

/** How long the team has to give a first response, per priority. */
const RESPONSE_HOURS = { Urgent: 1, High: 4, Normal: 8, Low: 24 };

/** Roles that can be handed a fresh ticket by the round-robin. */
const ASSIGNABLE_ROLES = ['project_manager', 'employee'];

const OPEN_STATUSES = ['Open', 'In Progress'];

/**
 * The next ticket number.
 *
 * Lived inline in the create route until a second caller needed it -- a
 * request a client held until their allowance reset becomes a real ticket when
 * it lands, and it has to be numbered the same way as every other one rather
 * than by a second copy of this that drifts.
 */
async function nextTicketId() {
  const { db } = require('../db/setup');
  const all = await db.all('tickets');
  const numbers = all
    .map((t) => parseInt(String(t.id).replace('ticket-', ''), 10))
    .filter((n) => !Number.isNaN(n));
  return `ticket-${(numbers.length ? Math.max(...numbers) : 1000) + 1}`;
}

/**
 * Create a ticket, retrying if two of them took the same number.
 *
 * `nextTicketId` is `max(existing) + 1` read from a full scan, which is not a
 * reservation: two requests a millisecond apart both read the same maximum,
 * both compute the same id, and the second insert hits the primary key and
 * comes back as a 500 to a client who did nothing wrong. It is rare and it is
 * exactly the kind of rare that happens on the busiest morning.
 *
 * Retrying rather than switching to a sequence, because the id is a
 * human-facing reference ("ticket-1043") that staff read out, both database
 * drivers have to produce it, and Firestore has no sequences. Re-reading the
 * maximum is what makes the second attempt different from the first.
 *
 * Only a collision is retried. Any other failure is the caller's to handle.
 */
async function insertTicket(fields, { attempts = 5 } = {}) {
  const { db } = require('../db/setup');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await db.insert('tickets', { id: await nextTicketId(), ...fields });
    } catch (err) {
      const collision = /duplicate key|UNIQUE|already exists|23505/i.test(String(err?.message || ''))
        || err?.code === '23505';
      if (!collision || attempt === attempts) throw err;
      // A short, uneven wait, so two callers that collided do not collide
      // again on the same millisecond.
      await new Promise((resolve) => { setTimeout(resolve, 5 + Math.floor(Math.random() * 20)); });
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('Could not allocate a ticket number.');
}

/**
 * The longest a ticket's own fields may be.
 *
 * Every one of these was unbounded, and the subject in particular is printed
 * in a Slack message, an email subject line, an in-app notification and an
 * admin's list -- so a megabyte of text in it is not a database problem, it is
 * four screens of the product ruined by one request. The limits are generous
 * enough that no honest ticket meets them.
 */
const LIMITS = { subject: 200, description: 20000 };

/**
 * The ticket's text fields, checked rather than coerced.
 *
 * Strict about the type before the length: `String(value)` on an object
 * produces "[object Object]", which is a perfectly valid-looking subject, and
 * on an array it produces the elements joined by commas -- which is how
 * `{ category: ['Site down'] }` reached the plan rules looking exactly like
 * the string "Site down" and bought a Managed client an uncounted change
 * request. Anything that is not a string is refused by name.
 *
 * Returns `{ ok: true, value }` with the trimmed text, or `{ ok: false,
 * error }` with the sentence to show the person who typed it.
 */
function cleanText(label, value, { max, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return { ok: false, error: `${label} is required.` };
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${label} has to be text.` };
  }
  const trimmed = value.trim();
  if (required && !trimmed) return { ok: false, error: `${label} is required.` };
  if (trimmed.length > max) {
    return { ok: false, error: `${label} is too long -- keep it under ${max} characters.` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Everything a ticket arrives with, validated together.
 *
 * One place rather than per route, because the create route and the edit route
 * were trusting different amounts of the same body: a category refused at
 * creation could be set on the next PUT, which is a hole with a billing rule
 * on the other side of it.
 *
 * `requireCategory` is false for an edit, where a body that does not mention
 * the category is leaving it alone rather than clearing it.
 */
function validateTicketFields(body = {}, { requireSubject = true, requireCategory = true } = {}) {
  const subject = cleanText('A subject', body.subject, { max: LIMITS.subject, required: requireSubject });
  if (!subject.ok) return subject;

  const description = cleanText('The description', body.description, { max: LIMITS.description });
  if (!description.ok) return description;

  const plans = require('../lib/plans');
  let category = null;
  const given = body.category;
  if (given === undefined || given === null || given === '') {
    if (requireCategory) {
      return { ok: false, error: `Pick a category: ${plans.TICKET_CATEGORIES.join(', ')}.` };
    }
  } else {
    category = plans.canonicalCategory(given);
    if (!category) {
      return {
        ok: false,
        error: `"${typeof given === 'string' ? given : 'That'}" is not a category. `
          + `Pick one of: ${plans.TICKET_CATEGORIES.join(', ')}.`,
      };
    }
  }

  return {
    ok: true,
    value: {
      subject: subject.value,
      description: description.value,
      category,
      priority: normalizePriority(body.priority),
    },
  };
}

function normalizePriority(value) {
  if (typeof value !== 'string') return 'Normal';
  const match = PRIORITIES.find((p) => p.toLowerCase() === value.trim().toLowerCase());
  return match || 'Normal';
}

function responseDueAt(priority, from = Date.now()) {
  return from + (RESPONSE_HOURS[priority] ?? RESPONSE_HOURS.Normal) * HOUR_MS;
}

function autoAssignEnabled() {
  return String(process.env.TICKET_AUTO_ASSIGN || 'on').toLowerCase() !== 'off';
}

/**
 * Least-loaded assignment: whoever currently owns the fewest open tickets gets
 * the next one. Ties break by name so the result is stable and testable.
 */
async function pickAssignee() {
  if (!autoAssignEnabled()) return null;

  const [users, tickets] = await Promise.all([db.all('users'), db.all('tickets')]);
  const candidates = users.filter((u) => ASSIGNABLE_ROLES.includes(u.role));
  if (candidates.length === 0) return null;

  const load = new Map(candidates.map((u) => [u.id, 0]));
  for (const t of tickets) {
    if (t.assigneeId && load.has(t.assigneeId) && OPEN_STATUSES.includes(t.status)) {
      load.set(t.assigneeId, load.get(t.assigneeId) + 1);
    }
  }

  return candidates.sort((a, b) => {
    const diff = load.get(a.id) - load.get(b.id);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  })[0];
}

function ticketUrl(ticketId) {
  const base = require('./appUrl').baseUrl();
  if (!base) return null;
  return ticketId ? `${base}/portal/tickets?ticket=${encodeURIComponent(ticketId)}` : `${base}/portal/tickets`;
}

/**
 * Start the ticket in ClickUp so the team works one queue. Non-fatal by
 * design: a ticket that exists here must never fail because ClickUp is down.
 * Needs CLICKUP_API_TOKEN plus CLICKUP_TICKETS_LIST_ID.
 */
async function startInClickUp(ticket, { clientName } = {}) {
  if (!clickup.isEnabled()) return null;
  if (!clickup.ticketsListId()) {
    console.warn(
      `ClickUp is connected but CLICKUP_TICKETS_LIST_ID is not set, so ticket ${ticket.id} was not started there.`,
    );
    return null;
  }
  try {
    const task = await clickup.mirrorTicket(ticket, { clientName });
    if (!task) return null;
    return db.update('tickets', ticket.id, { clickupTaskId: task.id, clickupTaskUrl: task.url });
  } catch (err) {
    console.error(`Could not start ticket ${ticket.id} in ClickUp:`, err.message);
    return null;
  }
}

/**
 * Open the Slack thread for this ticket and remember where it is.
 *
 * Every later update replies inside that thread, which is what lets the client
 * portal show one clean conversation instead of scattered channel posts.
 */
async function openSlackThread(ticket, { client, assignee }) {
  const link = ticketUrl(ticket.id);
  const who = client?.name ? `${client.name}${client.company ? ` (${client.company})` : ''}` : 'A client';
  const due = ticket.responseDueAt ? new Date(ticket.responseDueAt).toLocaleString() : 'no deadline set';

  const lines = [
    `🎫 *New ${ticket.priority} ticket*: ${ticket.subject}`,
    `• Ticket: ${ticket.id}`,
    `• From: ${who}`,
    `• Category: ${ticket.category}`,
    `• First response due: ${due}`,
    `• Owner: ${assignee?.name || 'unassigned'}`,
  ];
  if (ticket.clickupTaskUrl) lines.push(`• ClickUp task: ${ticket.clickupTaskUrl}`);
  if (ticket.description) lines.push(`• Details: ${String(ticket.description).slice(0, 400)}`);
  if (link) lines.push(link);

  const posted = await slack.notifySlack(lines.join('\n'), process.env.SLACK_TICKET_CHANNEL);
  if (!posted) return null;

  return db.update('tickets', ticket.id, {
    slackChannelId: posted.channelId,
    slackThreadTs: posted.ts,
  });
}

/** Email fan-out for a newly raised ticket: the whole admin roster, plus the owner. */
async function emailNewTicket(ticket, { client, assignee }) {
  const staffInboxes = await admins.adminEmails({ extra: assignee?.email ? [assignee.email] : [] });

  await mailer.sendTemplate({
    to: staffInboxes,
    message: messages.newTicketForStaff({
      ticket,
      clientName: client?.name || null,
      assigneeName: assignee?.name || null,
      clickupUrl: ticket.clickupTaskUrl || null,
    }),
    template: 'new_ticket_staff',
    entity: 'ticket',
    entityId: ticket.id,
  });

  // The client gets their own receipt, never the internal one.
  if (client?.email) {
    await mailer.sendTemplate({
      to: client.email,
      message: messages.ticketReceiptForClient({
        ticket,
        clientName: client.name,
        assigneeName: assignee?.name || null,
      }),
      template: 'ticket_receipt_client',
      entity: 'ticket',
      entityId: ticket.id,
    });
  }
}

/**
 * Run the whole intake pipeline for a ticket that has just been inserted.
 * Returns the ticket as it now stands (assignee and SLA applied).
 */
async function onTicketCreated(ticket) {
  let current = ticket;

  const assignee = ticket.assigneeId ? await db.find('users', ticket.assigneeId) : await pickAssignee();
  if (assignee && assignee.id !== current.assigneeId) {
    current = (await db.update('tickets', current.id, { assigneeId: assignee.id })) || current;
  }

  const [client, staff] = await Promise.all([
    current.clientId ? db.find('users', current.clientId) : null,
    db.filter('users', (u) => ['admin', 'project_manager'].includes(u.role)),
  ]);

  // Start it in ClickUp first, so the Slack post and the email carry the link.
  current = (await startInClickUp(current, { clientName: client?.name })) || current;

  // In-app: admins and PMs see it in their bell, the owner gets a direct nudge.
  const targets = new Set(staff.map((u) => u.id));
  if (assignee) targets.add(assignee.id);
  for (const id of targets) {
    const message = assignee && id === assignee.id
      ? `You were assigned a new ${current.priority} ticket: "${current.subject}"`
      : `New ${current.priority} ticket from ${client?.name || 'a client'}: "${current.subject}"`;
    await notify(id, message, 'ticket');
  }

  // Slack first so the email can be sent knowing the thread exists; both are
  // best-effort, and a failure in either leaves a perfectly valid ticket.
  try {
    current = (await openSlackThread(current, { client, assignee })) || current;
  } catch (err) {
    console.error(`Could not open the Slack thread for ticket ${current.id}:`, err.message);
  }

  try {
    await emailNewTicket(current, { client, assignee });
  } catch (err) {
    console.error(`Could not email out ticket ${current.id}:`, err.message);
  }

  return current;
}

/**
 * Mirror one line of ticket activity into the places people are already
 * watching: the ClickUp task and the ticket's Slack thread. Best-effort, and
 * deliberately terse -- the portal is where the detail lives.
 */
async function echoActivity(ticket, text) {
  if (!text) return;

  if (ticket.slackChannelId && ticket.slackThreadTs) {
    await slack.replyInThread({
      channelId: ticket.slackChannelId,
      threadTs: ticket.slackThreadTs,
      text,
    });
  }

  if (ticket.clickupTaskId && clickup.isEnabled()) {
    try {
      await clickup.addComment(ticket.clickupTaskId, text);
    } catch (err) {
      console.error(`Could not mirror activity for ticket ${ticket.id} to ClickUp:`, err.message);
    }
  }
}

/**
 * Stamp the first response time the first time the team says anything. Used by
 * the dashboard to show whether the SLA was actually met.
 */
async function markFirstResponse(ticket, actor) {
  if (!ticket || ticket.firstResponseAt) return ticket;
  if (!actor || actor.role === 'client') return ticket;
  return (await db.update('tickets', ticket.id, { firstResponseAt: Date.now() })) || ticket;
}

module.exports = {
  LIMITS,
  cleanText,
  validateTicketFields,
  insertTicket,
  PRIORITIES,
  RESPONSE_HOURS,
  startInClickUp,
  nextTicketId,
  normalizePriority,
  responseDueAt,
  pickAssignee,
  onTicketCreated,
  markFirstResponse,
  echoActivity,
  ticketUrl,
};
