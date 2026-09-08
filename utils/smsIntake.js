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
const conversations = require('./smsConversations');

/** Roles that should hear about an inbound client text. */
const NOTIFY_ROLES = ['admin', 'project_manager'];

/**
 * Below this, a text is short enough to read at a glance and the summary is
 * shown in Slack only above it. Roughly two lines on a phone.
 */
const SUMMARY_MIN_LENGTH = 180;

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
 * Post the message into the team's SMS channel -- inside that customer's own
 * thread when one already exists, so a reply typed there routes back to them
 * (see routes/slackEvents.js). The first message from a number opens the
 * thread; the conversation record remembers where it is for every message
 * after that, including a reply sent from the dashboard instead of Slack.
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

  const phoneNumber = twilio.normalizePhone(message.fromNumber);
  const conversation = phoneNumber
    ? await conversations.getOrCreate({ phoneNumber, clientId: client?.id || null })
    : null;

  const who = client
    ? [client.name, client.company].filter(Boolean).join(', ')
    : 'Unknown sender';

  const lines = [`*${who}*`, message.fromNumber || '', ''];

  // What they actually said comes first. A summary is a convenience for
  // scanning; the words a client chose are what somebody needs before replying.
  // Slack turns a leading > into a quote block, one line at a time.
  const body = String(message.body || '').slice(0, 1200);
  if (body) lines.push(body.split('\n').map((line) => `> ${line}`).join('\n'), '');

  const meta = [];
  if (message.aiPriority) meta.push(`Priority: ${message.aiPriority}`);
  if (message.aiCategory) meta.push(`Category: ${message.aiCategory}`);
  if (meta.length > 0) lines.push(meta.join(' | '));

  // Only worth the room when the message is long enough that reading it whole
  // is a chore. Under that, a summary of two sentences just says them again.
  if (message.aiSummary && body.length > SUMMARY_MIN_LENGTH) {
    lines.push(`Summary: ${message.aiSummary}`);
  }

  if (!client) lines.push('Not linked to a client yet.');

  const link = inboxUrl();
  if (link) lines.push('', `View in dashboard: ${link}`);

  const text = lines.join('\n').trim();

  if (conversation?.slackChannelId && conversation?.slackThreadTs) {
    return slack.replyInThread({
      channelId: conversation.slackChannelId,
      threadTs: conversation.slackThreadTs,
      text,
    });
  }

  const posted = await slack.notifySlack(text, channel);
  if (posted && conversation) {
    await conversations.attachThread(conversation.id, { channelId: posted.channelId, threadTs: posted.ts });
  }
  return posted;
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
