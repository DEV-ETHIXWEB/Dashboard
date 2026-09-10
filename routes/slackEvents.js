'use strict';

/**
 * The other half of the SMS <-> Slack bridge: the commands a team types in a
 * task's thread, and the one text that eventually goes back to the customer.
 *
 * Mounted directly on the app in server.js, ahead of express.json(), the same
 * way routes/sms.js and routes/billing.js are -- Slack signs the exact bytes
 * it sent, and nothing may parse the body before that signature is checked.
 *
 * Two rules shape everything below.
 *
 * The first is loop prevention: a message this bridge itself posted into Slack
 * must never be read back as a command. Bot posts and message subtypes are
 * dropped before anything else looks at them.
 *
 * The second is the outbound rule, and it is the reason this file was rewritten
 * rather than extended. An earlier version texted the customer on *every* staff
 * reply in the thread, which made a Slack thread unusable for actually
 * discussing the work. Now a thread is a workspace: people talk in it freely,
 * and exactly one message ever reaches the customer -- the completion that
 * `@send` produces, once, from a task that somebody has taken ownership of.
 */

const { db } = require('../db/setup');
const slack = require('../utils/slack');
const twilio = require('../utils/twilio');
const tasks = require('../utils/smsTasks');
const completion = require('../utils/smsCompletion');
const live = require('../utils/liveBus');

const PG_UNIQUE_VIOLATION = '23505';

// --- commands --------------------------------------------------------------

/**
 * Read a thread message as a command, or decide it is ordinary conversation.
 *
 * Everything uses one `@` prefix. Slack's own `/` commands are a different
 * mechanism entirely -- they need a public endpoint per command and never
 * appear as message events -- and mixing the two prefixes would mean half the
 * verbs in this flow lived somewhere else. So `@` throughout, and a message
 * that does not start with a known one is just a message.
 *
 * Note what Slack does to the text before we see it: a real user mention
 * arrives as `<@U123>` or `<@U123|name>`, while `@accept` stays literal text
 * because no such user exists. That asymmetry is what makes this parseable.
 */
function parseCommand(raw) {
  const text = String(raw || '').trim();
  const match = /^@(accept|assign|send)\b\s*([\s\S]*)$/i.exec(text);
  if (!match) return null;

  const name = match[1].toLowerCase();
  const rest = match[2].trim();

  if (name === 'assign') {
    const mention = /<@([A-Z0-9]+)(?:\|[^>]*)?>/.exec(rest);
    return { name, userId: mention ? mention[1] : null };
  }

  // `@send` on its own asks for a draft; `@send <text>` sends those exact words.
  if (name === 'send') return { name, override: rest || null };

  return { name };
}

/** One-line answer in the task's thread. Best-effort, like every Slack call. */
async function say(task, text) {
  return slack.replyInThread({
    channelId: task.slackChannelId,
    threadTs: task.slackMessageTs,
    text,
  });
}

// --- the one outbound text -------------------------------------------------

/**
 * Text the customer, and keep the record either way.
 *
 * Returns true only when Twilio accepted the message. A false here must leave
 * the task open -- a customer who never got the completion still has an open
 * problem, and closing the card would hide it from the only people who could
 * notice. Twilio failing is not this function failing; losing the attempt is.
 */
async function sendToCustomer(task, text) {
  const base = {
    provider: 'twilio',
    channel: 'sms',
    direction: 'outbound',
    fromNumber: twilio.fromNumber() || null,
    toNumber: task.phoneNumber,
    body: text,
    numMedia: 0,
    clientId: task.clientId || null,
    status: 'read',
    createdAt: new Date().toISOString(),
  };

  if (!twilio.outboundEnabled()) {
    await db.insert('sms_messages', {
      ...base,
      deliveryStatus: 'failed',
      deliveryError: 'Replying by SMS is switched off until the number is registered for A2P 10DLC.',
    });
    live.publish('sms');
    return false;
  }

  const sid = await twilio.sendSms({ to: task.phoneNumber, body: text });
  await db.insert('sms_messages', {
    ...base,
    providerSid: sid || null,
    deliveryStatus: sid ? 'sent' : 'failed',
    deliveryError: sid ? null : 'Twilio would not accept the message. Check the server log.',
  });
  live.publish('sms');
  return Boolean(sid);
}

// --- the state machine -----------------------------------------------------

async function handleAccept(task, event, client) {
  if (task.state !== 'NEW') {
    return say(task, `This task is already *${task.state}* -- \`@accept\` only works on a new one.`);
  }
  await tasks.transition(task, {
    state: 'ACCEPTED',
    acceptedBy: event.user,
    acceptedAt: new Date().toISOString(),
  }, client);
  return null;
}

async function handleAssign(task, command, event, client) {
  if (task.state !== 'ACCEPTED' && task.state !== 'ASSIGNED') {
    return say(task, `This task is *${task.state}* -- \`@accept\` it first, then assign an owner.`);
  }
  if (!command.userId) {
    return say(task, 'Name somebody to own this, like `@assign @alex`.');
  }
  await tasks.transition(task, {
    state: 'ASSIGNED',
    ownerSlackId: command.userId,
    assignedAt: new Date().toISOString(),
  }, client);
  return null;
}

/**
 * The end of a task: write the completion, text it, close the card.
 *
 * Gated on ASSIGNED because somebody has to own a piece of work before it can
 * be reported finished. `@send <text>` skips the drafting step but not the
 * gate -- the exemption is about who chose the words, not about whether the
 * task was ever picked up.
 */
async function handleSend(task, command, client) {
  if (task.state !== 'ASSIGNED') {
    return say(task, `This task is *${task.state}* -- assign an owner with \`@assign @person\` before sending anything to the customer.`);
  }
  if (task.sentAt) {
    return say(task, 'A message has already gone to this customer for this task.');
  }
  if (!task.phoneNumber) {
    return say(task, 'There is no phone number on this task, so there is nowhere to send.');
  }

  let text = command.override;

  if (!text) {
    // Read the thread fresh: the notes this draft is built from were usually
    // typed seconds ago, and a cached copy would miss exactly those.
    let notes = '';
    try {
      const replies = await slack.fetchMessageReplies(task.slackChannelId, task.slackMessageTs, { fresh: true });
      notes = completion.notesFromThread(replies);
    } catch (err) {
      console.error(`Could not read the thread for task ${task.id}:`, err.message);
    }

    const drafted = await completion.draft({
      originalBody: task.originalBody,
      summary: task.summary,
      notes,
    });

    if (drafted.error) return say(task, drafted.error);
    text = drafted.message;

    await say(task, `*Draft:*\n> ${text}`);
  }

  const delivered = await sendToCustomer(task, text);

  if (!delivered) {
    // Deliberately still open. See sendToCustomer.
    return say(task, '⚠️ That did not send -- the attempt is recorded in the dashboard and the task is still open. Check the delivery error there, then try `@send` again.');
  }

  await tasks.transition(task, {
    state: 'CLOSED',
    sentBody: text,
    sentAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
  }, client);

  return say(task, `✅ Sent to ${task.phoneNumber}:\n> ${text}`);
}

/**
 * Decide whether a Slack `message` event is a command in a task thread, and run
 * it if so. Every early return below is a scoping or loop-prevention rule --
 * the large majority of events a Slack workspace generates are not this, and
 * silently ignoring them is correct.
 */
async function handleMessageEvent(event) {
  if (!event || event.type !== 'message') return;

  // Our own bot post (a card, a draft, a confirmation), a message edit, a
  // delete, a channel-join line -- anything that is not a plain message a human
  // just typed. Reacting to any of these is the echo loop this bridge must
  // never create.
  if (event.bot_id || event.subtype) return;
  if (!event.user || typeof event.text !== 'string' || !event.text.trim()) return;

  // Only a reply *inside* a thread can be a command: the thread is what names
  // the task. A new top-level message in the channel belongs to nothing.
  if (!event.thread_ts) return;

  // Scoped to the one channel this bridge posts cards into, so a thread_ts that
  // happens to collide with something else in the workspace can never be
  // mistaken for a task.
  const smsChannel = process.env.SMS_SLACK_CHANNEL || process.env.SLACK_NOTIFICATION_CHANNEL;
  if (!smsChannel || event.channel !== smsChannel) return;

  // Ordinary conversation. This is the common case in a working thread and the
  // whole point of the outbound rule: people can talk here without anything
  // reaching the customer.
  const command = parseCommand(event.text);
  if (!command) return;

  const task = await tasks.findByCard(event.channel, event.thread_ts);
  if (!task) return; // a thread this bridge did not open

  const client = task.clientId ? await db.find('users', task.clientId) : null;

  if (task.state === 'CLOSED') {
    await say(task, 'This task is closed. Start a new one by having the customer text in again.');
    return;
  }

  if (command.name === 'accept') await handleAccept(task, event, client);
  else if (command.name === 'assign') await handleAssign(task, command, event, client);
  else if (command.name === 'send') await handleSend(task, command, client);
}

/**
 * Slack posts here for the one-time URL verification handshake and for every
 * subscribed event after that.
 */
async function eventsHandler(req, res) {
  if (!slack.isEventsEnabled()) {
    console.error('A Slack event arrived but SLACK_SIGNING_SECRET is not set.');
    return res.status(503).end();
  }

  if (!slack.verifyEventSignature(req)) {
    // As with the Twilio webhook, the body is not trustworthy at all past this
    // point, so nothing below reads anything out of it.
    console.error('Rejected a Slack event with a bad signature or a stale timestamp.');
    return res.status(403).end();
  }

  let payload;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    payload = JSON.parse(raw);
  } catch {
    return res.status(400).end();
  }

  // The handshake Slack performs once, when the Request URL is first saved in
  // the app's Event Subscriptions settings.
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  if (payload.type !== 'event_callback') return res.status(200).end();

  // Slack retries a delivery it did not get a prompt 200 for. The event id is
  // the only thing that tells two deliveries of the same event apart from two
  // different events, so a UNIQUE column makes a retry a no-op rather than a
  // second outbound text -- the same trick provider_sid plays for Twilio in
  // routes/sms.js. Claimed before the work runs, deliberately: @send drafts and
  // sends, which is slower than Slack's retry timer, and a duplicate send is a
  // worse outcome than a dropped retry.
  const eventId = payload.event_id;
  if (eventId) {
    try {
      await db.insert('slack_events', { id: eventId, processedAt: new Date().toISOString() });
    } catch (err) {
      if (err?.code === PG_UNIQUE_VIOLATION) return res.status(200).end();
      throw err;
    }
  }

  try {
    await handleMessageEvent(payload.event);
  } catch (err) {
    // 200 either way: it only means "received", and Slack retrying a command
    // that half-ran is worse than the failure being in the log alone.
    console.error('Could not process a Slack message event:', err.message);
  }

  return res.status(200).end();
}

module.exports = { eventsHandler, handleMessageEvent, parseCommand };
