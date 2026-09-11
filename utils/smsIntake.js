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
const conversations = require('./smsConversations');
const tasks = require('./smsTasks');

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

// --- telling people --------------------------------------------------------

/**
 * Put the message in front of the team as a task.
 *
 * The first text from a number with no task open opens one: a card posted to
 * the SMS channel, which is also the thread every command and every follow-up
 * for that task is typed into (see utils/smsTasks.js and routes/slackEvents.js).
 *
 * A text that arrives while a task is already open is appended to that task's
 * thread instead, and the card is repainted rather than replaced. A customer
 * who sends three messages in a row has one problem, not three, and giving
 * them three cards is how a worklist stops being one.
 *
 * Nothing here replies to the customer. The only outbound text in this whole
 * flow is the one @send produces.
 */
async function postToSlack(message, client) {
  if (!slack.isEnabled()) return null;

  // Resolved to an id, and shared with the event handler that has to match it
  // against `event.channel`. See tasks.channelId.
  const channel = await tasks.channelId();
  if (!channel) return null;

  const phoneNumber = twilio.normalizePhone(message.fromNumber);
  const conversation = phoneNumber
    ? await conversations.getOrCreate({ phoneNumber, clientId: client?.id || null })
    : null;
  if (!conversation) return null;

  const existing = await tasks.findOpen(conversation.id);

  if (existing) {
    const body = String(message.body || '').slice(0, 1200);
    const lines = ['*They texted again:*'];
    if (body) lines.push(body.split('\n').map((line) => `> ${line}`).join('\n'));

    const posted = await slack.replyInThread({
      channelId: existing.slackChannelId,
      threadTs: existing.slackMessageTs,
      text: lines.join('\n'),
    });

    // Repaint so the time-open on the card is current for whoever reads it
    // next. The card keeps the message that opened the task -- that is the
    // task's identity, and the newer text is one scroll below it in the thread.
    await tasks.refreshCard(existing, client);
    return posted;
  }

  const task = await tasks.open({
    conversation,
    client,
    message,
    priority: tasks.priorityFromTriage(message.aiPriority),
    summary: message.aiSummary || null,
  });
  if (!task) return null;

  // The conversation keeps pointing at the newest card, so a dashboard reply
  // still echoes into the thread the team is actually looking at.
  await conversations.attachThread(conversation.id, {
    channelId: task.slackChannelId,
    threadTs: task.slackMessageTs,
  });

  return { channelId: task.slackChannelId, ts: task.slackMessageTs };
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
