'use strict';

/**
 * A customer's text, turned into one tracked unit of work.
 *
 * The card is the task. It is posted once, as a top-level message in the SMS
 * channel, and edited in place for the rest of the task's life -- never
 * followed by a "now accepted" or "now assigned" message. A channel where every
 * state change is a new post is a channel nobody reads; a channel where each
 * task is one line that keeps itself current is a worklist.
 *
 * The card's timestamp doubles as the thread id, because that is what a Slack
 * thread is: replies hang off their parent's ts. So the card is also the
 * address every command for this task is typed into, and finding the task a
 * command belongs to is one lookup on (channel, ts).
 *
 * Nothing here texts the customer. That happens in exactly one place -- the
 * @send handler in routes/slackEvents.js -- and this module only records that
 * it happened.
 */

const { db } = require('../db/setup');
const slack = require('./slack');
const appUrl = require('./appUrl');

/** The whole state machine, in the only order it can be walked. */
const STATES = ['NEW', 'ACCEPTED', 'ASSIGNED', 'CLOSED'];

/**
 * The priority a human reads on the card.
 *
 * Deliberately its own vocabulary rather than reusing the ticket priorities in
 * utils/smsTriage.js. Those feed an SLA clock and are shared with the ticket
 * system; these are a label on a Slack card and nothing more -- no timer, no
 * escalation, no reminder reads them. The mapping below is the only place the
 * two vocabularies meet.
 */
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

const FROM_TRIAGE = {
  Urgent: 'urgent',
  High: 'high',
  Normal: 'medium',
  Low: 'low',
};

const PRIORITY_EMOJI = {
  urgent: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

function priorityFromTriage(triagePriority) {
  return FROM_TRIAGE[triagePriority] || 'medium';
}

// --- which channel ---------------------------------------------------------

/**
 * The channel the bridge lives in, as an id.
 *
 * This used to be an inline `process.env.SMS_SLACK_CHANNEL || ...` in three
 * places -- here, in utils/smsIntake.js, and in the event handler that decides
 * whether a message is in scope -- and the third one compared that raw string
 * against `event.channel`. So a channel configured by name worked for posting
 * and failed for reading: cards appeared, every command in their threads was
 * dropped without a word, and nothing in the flow could report it because
 * nothing had noticed. One resolver, returning an id, is the fix.
 *
 * The resolved value is cached against the setting it came from, so a changed
 * env var is picked up on the next call rather than needing a restart.
 */
let resolvedChannel = null;

function configuredChannel() {
  return process.env.SMS_SLACK_CHANNEL || process.env.SLACK_NOTIFICATION_CHANNEL || null;
}

async function channelId() {
  const configured = configuredChannel();
  if (!configured) return null;
  if (resolvedChannel?.configured === configured) return resolvedChannel.id;

  try {
    const id = await slack.resolveChannelId(configured);
    // Only successes are cached. A lookup that failed because Slack was
    // briefly unreachable must be retried, not remembered as "no channel".
    if (id) resolvedChannel = { configured, id };
    return id;
  } catch (err) {
    console.error(`Could not resolve the SMS Slack channel ("${configured}"):`, err.message);
    return null;
  }
}

// --- lookups ---------------------------------------------------------------

/**
 * The open task for a conversation, if there is one.
 *
 * "Open" is anything that is not CLOSED. This is what stops a customer sending
 * three texts in a row and getting three cards -- the second and third are
 * appended to whatever this returns. A closed task deliberately does not match,
 * so a number that comes back next week starts a fresh one.
 */
async function findOpen(conversationId) {
  if (!conversationId) return null;
  const rows = await db.filter(
    'sms_tasks',
    (t) => t.conversationId === conversationId && t.state !== 'CLOSED',
  );
  // Newest first, so a row left open by a failure somewhere cannot shadow the
  // task the team is actually looking at.
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return rows[0] || null;
}

/** The task a Slack command was typed into, found by the card it hangs under. */
async function findByCard(channelId, messageTs) {
  if (!channelId || !messageTs) return null;
  const rows = await db.filter(
    'sms_tasks',
    (t) => t.slackChannelId === channelId && t.slackMessageTs === messageTs,
  );
  return rows[0] || null;
}

// --- the card --------------------------------------------------------------

/** "3m", "2h 14m", "1d 3h" -- long enough to be useful, short enough to scan. */
function elapsed(since) {
  const started = Date.parse(since || '');
  if (!Number.isFinite(started)) return 'just now';

  const minutes = Math.max(0, Math.round((Date.now() - started) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem ? `${days}d ${rem}h` : `${days}d`;
}

function inboxUrl() {
  const base = appUrl.baseUrl();
  return base ? `${base}/portal/sms` : null;
}

/**
 * The card's text, rebuilt from scratch on every state change.
 *
 * Rebuilt rather than patched because the card has to be correct, not
 * incremental: whatever this returns becomes the whole message after the edit,
 * so a field left out here disappears from Slack.
 */
function renderCard(task, client) {
  const priority = String(task.priority || 'medium');
  const tag = `${PRIORITY_EMOJI[priority] || '🟡'} *${priority.toUpperCase()}*`;
  const who = client
    ? [client.name, client.company].filter(Boolean).join(', ')
    : 'Unknown sender';

  const lines = [`${tag} · *${who}*`, task.phoneNumber || '', ''];

  if (task.summary) lines.push(task.summary, '');

  // The customer's own words, quoted. A summary is for scanning; nobody should
  // answer a person without having read what they actually wrote.
  const body = String(task.originalBody || '').slice(0, 1200);
  if (body) lines.push(body.split('\n').map((line) => `> ${line}`).join('\n'), '');

  const state = [`*State:* ${task.state}`];
  if (task.ownerSlackId) state.push(`*Owner:* <@${task.ownerSlackId}>`);
  else if (task.acceptedBy) state.push(`*Claimed by:* <@${task.acceptedBy}>`);
  state.push(task.state === 'CLOSED'
    ? `*Closed after:* ${elapsed(task.createdAt)}`
    : `*Open:* ${elapsed(task.createdAt)}`);
  lines.push(state.join(' · '));

  if (task.state === 'CLOSED' && task.sentBody) {
    lines.push('', `*Sent to customer:* ${task.sentBody}`);
  }

  // A task that was closed and then reopened because the carrier never
  // delivered the text. The most important line on the card when it applies:
  // the work is done, the customer does not know it, and somebody has to
  // decide what to do about a number that is refusing messages.
  if (task.deliveryFailure) {
    lines.push(
      '',
      `⚠️ *The completion text never reached them* -- ${task.deliveryFailure}`,
      task.sentBody ? `_It was going to say:_ ${task.sentBody}` : '',
      'The task is open again. Fix the number or try `@send` once more.',
    );
  }

  if (!client) lines.push('', 'Not linked to a client yet.');

  // Only worth the room while there is still something to do about it.
  if (task.state !== 'CLOSED') {
    lines.push('', '_Reply in this thread:_ `@accept` · `@assign @person` · `@send`');
  }

  const link = inboxUrl();
  if (link) lines.push('', `View in dashboard: ${link}`);

  return lines.join('\n').trim();
}

/**
 * Push the current state of a task onto its card.
 *
 * Still best-effort -- a failed edit leaves a stale card, and the row is the
 * truth either way -- but it now says whether the edit landed, which it used to
 * swallow. That silence was a real problem: the card is the *only* thing that
 * answers `@accept`, so a failed edit meant the person who typed it saw nothing
 * happen and typed it again. The caller uses the answer to say something in the
 * thread instead.
 */
async function refreshCard(task, client) {
  if (!task?.slackChannelId || !task?.slackMessageTs) {
    return { ok: false, error: 'this task has no card to update' };
  }
  try {
    await slack.updateMessage({
      channelId: task.slackChannelId,
      ts: task.slackMessageTs,
      text: renderCard(task, client),
    });
    return { ok: true };
  } catch (err) {
    console.error(`Could not update the card for task ${task.id}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// --- lifecycle -------------------------------------------------------------

/**
 * Open a task and post its card.
 *
 * Returns null when Slack is off or the post failed -- a task with no card has
 * no thread, so there would be nowhere to type a command and nothing to update.
 * The caller carries on: the message itself is already saved either way.
 */
async function open({ conversation, client, message, priority, summary }) {
  if (!slack.isEnabled()) return null;
  const channel = await channelId();
  if (!channel) return null;

  const now = new Date().toISOString();
  const draft = {
    conversationId: conversation?.id || null,
    phoneNumber: conversation?.phoneNumber || message.fromNumber || null,
    clientId: client?.id || null,
    state: 'NEW',
    priority: priority || 'medium',
    summary: summary || null,
    originalBody: String(message.body || '').slice(0, 2000),
    createdAt: now,
    updatedAt: now,
  };

  const posted = await slack.notifySlack(renderCard(draft, client), channel);
  if (!posted) return null;

  return db.insert('sms_tasks', {
    ...draft,
    slackChannelId: posted.channelId,
    slackMessageTs: posted.ts,
  });
}

/**
 * Record a state change and repaint the card in one step.
 *
 * Returns the new row and whether the repaint landed. The second half matters
 * because the card is the only acknowledgement most commands get: if the edit
 * failed, the caller has to say so in the thread, or the change is invisible.
 */
async function transition(task, patch, client) {
  const updated = (await db.update('sms_tasks', task.id, {
    ...patch,
    updatedAt: new Date().toISOString(),
  })) || { ...task, ...patch };

  const card = await refreshCard(updated, client);
  return { task: updated, cardUpdated: card.ok === true };
}

/** The task a Twilio delivery report belongs to, found by the SID it sent. */
async function findBySentSid(sid) {
  if (!sid) return null;
  const rows = await db.filter('sms_tasks', (t) => t.sentSid === sid);
  return rows[0] || null;
}

/**
 * Put a task back after the text it closed on never arrived.
 *
 * Closing on Twilio's first answer is right -- it is the only answer available
 * at the time -- but that answer only means Twilio took the message. When the
 * carrier rejects it half a minute later, the customer is still waiting and the
 * team has a card saying the job is done. So the state goes back to ASSIGNED,
 * and the send claim goes with it: `sent_at` is what refuses a second `@send`,
 * and a text that never landed has to be sendable again.
 *
 * The words that were sent are deliberately kept on the card as
 * `lastFailedBody`, not thrown away -- whoever picks this up wants to see what
 * the customer was supposed to receive.
 */
async function reopenAfterFailedDelivery(task, reason, client) {
  const updated = (await db.update('sms_tasks', task.id, {
    state: 'ASSIGNED',
    sentAt: null,
    sentSid: null,
    closedAt: null,
    updatedAt: new Date().toISOString(),
  })) || { ...task, state: 'ASSIGNED', sentAt: null, sentSid: null, closedAt: null };

  // Not persisted: the card renders it from this in-memory copy, and the durable
  // record of the failure is the sms_messages row the status callback updated.
  const card = await refreshCard({ ...updated, deliveryFailure: reason }, client);
  return { task: updated, cardUpdated: card.ok === true };
}

module.exports = {
  STATES,
  PRIORITIES,
  PRIORITY_EMOJI,
  priorityFromTriage,
  channelId,
  configuredChannel,
  findOpen,
  findByCard,
  findBySentSid,
  reopenAfterFailedDelivery,
  renderCard,
  refreshCard,
  elapsed,
  open,
  transition,
};
