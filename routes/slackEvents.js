'use strict';

/**
 * The other half of the SMS <-> Slack bridge: a staff reply posted in a
 * customer's thread, turned into an outbound text.
 *
 * Mounted directly on the app in server.js, ahead of express.json(), the same
 * way routes/sms.js and routes/billing.js are -- Slack signs the exact bytes
 * it sent, and nothing may parse the body before that signature is checked.
 *
 * The one rule everything below exists to enforce: a message this bridge
 * itself posted into Slack (the customer's text arriving, or a dashboard
 * reply being echoed there) must never be read back as a new staff reply.
 * That would text the customer their own message back on a loop.
 */

const { db } = require('../db/setup');
const slack = require('../utils/slack');
const twilio = require('../utils/twilio');
const conversations = require('../utils/smsConversations');
const live = require('../utils/liveBus');

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Send exactly one outbound text for a genuine staff reply, and persist the
 * outcome either way. Twilio failing is not this function failing -- the
 * record of the attempt is what must never be lost.
 */
async function sendReply(conversation, text) {
  const base = {
    provider: 'twilio',
    channel: 'sms',
    direction: 'outbound',
    fromNumber: twilio.fromNumber() || null,
    toNumber: conversation.phoneNumber,
    body: text,
    numMedia: 0,
    clientId: conversation.clientId || null,
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
    return;
  }

  const sid = await twilio.sendSms({ to: conversation.phoneNumber, body: text });
  await db.insert('sms_messages', {
    ...base,
    providerSid: sid || null,
    deliveryStatus: sid ? 'sent' : 'failed',
    deliveryError: sid ? null : 'Twilio would not accept the message. Check the server log.',
  });
  live.publish('sms');
}

/**
 * Decide whether a Slack `message` event is a genuine staff reply to a
 * tracked customer thread, and act on it if so. Every early return below is a
 * scoping or loop-prevention rule -- the large majority of events a Slack
 * workspace generates are not this, and silently ignoring them is correct.
 */
async function handleMessageEvent(event) {
  if (!event || event.type !== 'message') return;

  // Our own bot post (the inbound-text notification, or the dashboard-reply
  // echo), a message edit, a delete, a channel-join line -- anything that is
  // not a plain message a human just typed. Reacting to any of these is
  // exactly the echo loop this bridge must never create.
  if (event.bot_id || event.subtype) return;
  if (!event.user || typeof event.text !== 'string' || !event.text.trim()) return;

  // Only a reply *inside* an existing thread can be a reply to a customer.
  // A new top-level message in the channel has nowhere to route to.
  if (!event.thread_ts) return;

  // Scoped to the one channel this bridge posts customer threads into, so a
  // thread_ts that happens to collide with something else in the workspace
  // (a ticket thread, an unrelated conversation) can never be mistaken for one.
  const smsChannel = process.env.SMS_SLACK_CHANNEL || process.env.SLACK_NOTIFICATION_CHANNEL;
  if (!smsChannel || event.channel !== smsChannel) return;

  const conversation = await conversations.findByThread(event.channel, event.thread_ts);
  if (!conversation || !conversation.phoneNumber) return; // not a thread this bridge opened

  await sendReply(conversation, event.text.trim());
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
  // unique per delivery attempt of the *same* event, so a UNIQUE column makes
  // a retry a no-op rather than a second outbound text -- the same trick
  // provider_sid plays for Twilio in routes/sms.js.
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
    // A staff reply that failed to process must not read as delivered to
    // Slack's retry logic either way; 200 here only means "received", and the
    // failure is the thing worth keeping in the log.
    console.error('Could not process a Slack message event:', err.message);
  }

  return res.status(200).end();
}

module.exports = { eventsHandler, handleMessageEvent };
