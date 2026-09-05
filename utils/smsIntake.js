'use strict';

/**
 * What happens to a client's text between arriving and being someone's problem:
 * work out who sent it, read it, put it in front of the team, and -- when a
 * human says so -- turn it into a real ticket.
 *
 * Modelled on utils/ticketIntake.js, including its central rule: every side
 * effect here is best-effort. A message that was saved must never be reported
 * as failed because Slack, Anthropic, or the notification fan-out was down.
 */

const { db } = require('../db/setup');
const { notify } = require('../middleware/auth');
const slack = require('./slack');
const twilio = require('./twilio');
const smsTriage = require('./smsTriage');
const ticketIntake = require('./ticketIntake');
const appUrl = require('./appUrl');

/** Roles that should hear about an inbound client text. */
const NOTIFY_ROLES = ['admin', 'project_manager'];

// --- who sent it -----------------------------------------------------------

/**
 * Find the account a number belongs to.
 *
 * Exact E.164 first, because that is the only comparison that is certainly
 * right. The last-ten-digits fallback exists for numbers a person typed into
 * the people page, where a missing country code is ordinary -- see phoneKey in
 * utils/twilio.js for why the looser match is acceptable here.
 *
 * Returns null for a number nobody owns, which is a normal outcome and not an
 * error: the message is still kept and still shown, just unattributed.
 */
async function matchClient(fromNumber) {
  const normalized = twilio.normalizePhone(fromNumber);
  if (!normalized) return null;

  const withPhone = await db.filter('users', (u) => Boolean(u.phone));
  const exact = withPhone.find((u) => twilio.normalizePhone(u.phone) === normalized);
  if (exact) return exact;

  const key = twilio.phoneKey(normalized);
  if (!key) return null;
  return withPhone.find((u) => twilio.phoneKey(u.phone) === key) || null;
}

/** How this sender should be named on screen and in Slack. */
function senderLabel(message, client) {
  if (client) {
    return client.company ? `${client.name} (${client.company})` : client.name;
  }
  return `Unknown sender ${message.fromNumber || ''}`.trim();
}

function inboxUrl() {
  const base = appUrl.baseUrl();
  return base ? `${base}/portal/sms` : null;
}

// --- telling people --------------------------------------------------------

/**
 * Post the message into the team's SMS channel.
 *
 * The client's name leads, because that is what somebody scanning the channel
 * is looking for. The raw text is quoted underneath the summary rather than
 * replaced by it -- a summary is a convenience, and the actual words a client
 * used are the thing people need to be able to read.
 */
async function postToSlack(message, client) {
  if (!slack.isEnabled()) return null;

  const channel = process.env.SMS_SLACK_CHANNEL || process.env.SLACK_NOTIFICATION_CHANNEL;
  if (!channel) return null;

  const who = senderLabel(message, client);
  const lines = [`📱 *New text from ${who}*`];

  if (message.aiSummary) {
    const priority = message.aiPriority && message.aiPriority !== 'Normal' ? ` · *${message.aiPriority}*` : '';
    const category = message.aiCategory ? ` · ${message.aiCategory}` : '';
    lines.push(`_${message.aiSummary}_${priority}${category}`);
  }

  // Slack renders a leading > as a quote block, so each line needs its own.
  const body = String(message.body || '').slice(0, 1200);
  if (body) lines.push(body.split('\n').map((line) => `> ${line}`).join('\n'));

  if (!client) lines.push('_This number is not linked to a client yet._');

  const link = inboxUrl();
  if (link) lines.push(link);

  return slack.notifySlack(lines.join('\n'), channel);
}

/** In-app bell for the people who run the workspace. */
async function notifyStaff(message, client) {
  const staff = await db.filter('users', (u) => NOTIFY_ROLES.includes(u.role));
  const who = senderLabel(message, client);
  const gist = message.aiSummary || String(message.body || '').slice(0, 80);

  for (const person of staff) {
    await notify(person.id, `New text from ${who}: "${gist}"`, 'sms');
  }
}

// --- the pipeline ----------------------------------------------------------

/**
 * Everything that happens after the row exists.
 *
 * Returns the message as it now stands, with any triage applied. Each stage is
 * wrapped on its own so a failure in one does not skip the others: a Slack
 * outage must still leave the bell notification, and vice versa.
 *
 * Note what this deliberately does not do. It does not assign the message to
 * anybody, does not open a ticket, and does not reply to the client. The model
 * read a stranger's text; letting its answer trigger any of those would make
 * the message body a control surface. Promotion to a ticket is a human's
 * decision -- see `promoteToTicket`.
 */
async function onMessageReceived(message) {
  let current = message;

  const client = current.clientId ? await db.find('users', current.clientId) : null;

  try {
    const assessment = await smsTriage.triage({
      body: current.body,
      clientName: client?.name || null,
    });
    if (assessment) {
      current = (await db.update('sms_messages', current.id, {
        aiSummary: assessment.summary,
        aiIntent: assessment.intent,
        aiPriority: assessment.priority,
        aiCategory: assessment.category,
        aiAt: Date.now(),
      })) || current;
    }
  } catch (err) {
    console.error(`Could not triage message ${current.id}:`, err.message);
  }

  try {
    await postToSlack(current, client);
  } catch (err) {
    console.error(`Could not post message ${current.id} to Slack:`, err.message);
  }

  try {
    await notifyStaff(current, client);
  } catch (err) {
    console.error(`Could not notify staff about message ${current.id}:`, err.message);
  }

  return current;
}

/**
 * Turn one text into a real ticket, at a human's request.
 *
 * The triage fields seed the form -- subject, priority, category -- because a
 * suggestion a person has looked at and accepted is a different thing from a
 * model acting on its own. `actor` is the staff member who pressed the button,
 * and they own the result.
 */
async function promoteToTicket(message, actor, overrides = {}) {
  if (message.ticketId) return db.find('tickets', message.ticketId);

  const client = message.clientId ? await db.find('users', message.clientId) : null;
  const body = String(message.body || '').trim();

  const subject = (overrides.subject || message.aiSummary || body.slice(0, 60) || 'Client text message').slice(0, 200);
  const priority = ticketIntake.normalizePriority(overrides.priority || message.aiPriority);

  const ticket = await db.insert('tickets', {
    subject,
    category: overrides.category || message.aiCategory || 'Other',
    clientId: message.clientId || null,
    status: 'Open',
    description: `Raised from a text message sent by ${senderLabel(message, client)}.\n\n${body}`,
    priority,
    responseDueAt: ticketIntake.responseDueAt(priority),
    progress: 0,
    createdAt: new Date().toISOString(),
  });

  await db.update('sms_messages', message.id, { ticketId: ticket.id, status: 'read' });

  // Hand off to the existing pipeline so a ticket born here is identical to one
  // raised in the portal: SLA clock, owner, ClickUp task, Slack thread, emails.
  return ticketIntake.onTicketCreated(ticket);
}

module.exports = {
  matchClient,
  senderLabel,
  postToSlack,
  notifyStaff,
  onMessageReceived,
  promoteToTicket,
  NOTIFY_ROLES,
};
