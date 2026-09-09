'use strict';

/**
 * Inbound client texts: the Twilio webhook that receives them, and the
 * staff-only endpoints the dashboard inbox is built on.
 *
 * The webhook is the only public entry point in this file and the only one
 * that is not behind requireAuth, so it verifies Twilio's signature before it
 * reads a single field out of the body. Everything below it is staff-only --
 * a client never sees this section, and the live-wire topic is in STAFF_ONLY
 * for the same reason.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const twilio = require('../utils/twilio');
const intake = require('../utils/smsIntake');
const live = require('../utils/liveBus');
const slack = require('../utils/slack');
const conversations = require('../utils/smsConversations');

/** Who runs the inbox. Deliberately excludes clients and employees. */
const STAFF = ['admin', 'sales', 'project_manager'];

const STATUSES = ['new', 'read', 'archived'];

/** Postgres' unique-violation code, which is how a Twilio retry announces itself. */
const PG_UNIQUE_VIOLATION = '23505';

// --- the webhook -----------------------------------------------------------

/**
 * Empty TwiML: message received, nothing to say back.
 *
 * Answering with an empty <Response/> rather than a bare 200 is what stops
 * Twilio logging every delivery as a webhook that returned nothing useful. No
 * auto-reply is sent even when there is something to say -- see the STOP note
 * below and SMS_OUTBOUND_ENABLED in utils/twilio.js.
 */
function twiml(res, body = '') {
  res.set('Content-Type', 'text/xml');
  return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

/**
 * Twilio POSTs here whenever somebody texts the number.
 *
 * Mounted in server.js ahead of express.json() with its own urlencoded parser,
 * the same shape as the Stripe webhook, because the signature is computed over
 * the parsed form fields and nothing else may consume the body first.
 *
 * Work happens inline rather than after the response. On a long-lived server it
 * would be better to answer first and enrich afterwards, but this also deploys
 * to a serverless platform where the process is frozen the moment the response
 * is sent -- so anything deferred would simply never run. The whole path is
 * bounded well inside Twilio's 15-second budget (triage caps itself at 7s), and
 * the UNIQUE index on provider_sid makes a retry harmless if it ever is not.
 */
async function webhookHandler(req, res) {
  if (!twilio.isEnabled()) {
    console.error('An SMS webhook arrived but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set.');
    return res.status(503).end();
  }

  if (!twilio.verifySignature(req)) {
    // The body is not to be trusted at all here, so nothing is read out of it.
    // The usual cause is TWILIO_WEBHOOK_URL not matching the URL Twilio called
    // -- a missing www, http instead of https, a trailing slash.
    console.error(`Rejected an SMS webhook with a bad signature. Expected URL: ${twilio.signedUrl(req)}`);
    return res.status(403).end();
  }

  const {
    MessageSid, From, To, Body, NumMedia, SmsMessageSid,
  } = req.body || {};

  const providerSid = MessageSid || SmsMessageSid || null;
  const body = typeof Body === 'string' ? Body : '';
  const numMedia = Number(NumMedia) || 0;

  // Media lives behind Twilio's own basic auth, so only the references are kept
  // here; nothing in the browser is ever pointed straight at a Twilio URL.
  const media = [];
  for (let i = 0; i < Math.min(numMedia, 10); i += 1) {
    const url = req.body[`MediaUrl${i}`];
    if (url) media.push({ url, contentType: req.body[`MediaContentType${i}`] || null });
  }

  let message;
  try {
    const client = await intake.matchClient(From);
    message = await db.insert('sms_messages', {
      provider: 'twilio',
      providerSid,
      channel: String(To || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms',
      direction: 'inbound',
      fromNumber: From || null,
      toNumber: To || null,
      body,
      numMedia,
      mediaJson: media.length > 0 ? JSON.stringify(media) : null,
      clientId: client?.id || null,
      status: 'new',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Twilio re-sending a message it already delivered. The row exists, the
    // team has already been told, and the only correct answer is a clean 200 --
    // anything else and Twilio keeps trying.
    if (err?.code === PG_UNIQUE_VIOLATION) return twiml(res);
    throw err;
  }

  // The inbox lights up on the raw message; the summary follows a second later
  // on the second publish below.
  live.publish('sms');

  try {
    await intake.onMessageReceived(message);
  } catch (err) {
    // The message is saved either way, and that is the part that matters.
    console.error(`The intake pipeline failed for message ${message.id}:`, err.message);
  }

  live.publish('sms');

  // STOP and HELP are carrier-level keywords: Twilio handles the opt-out itself
  // and blocks further sends to that number, so there is nothing to do here but
  // keep the record. Replying is not possible anyway while SMS_OUTBOUND_ENABLED
  // is off, which it is until A2P 10DLC registration clears.
  return twiml(res);
}

// --- the inbox -------------------------------------------------------------

router.use(requireAuth, requireRole(...STAFF));

/** A message plus the display fields the inbox needs, so it makes one request. */
function present(message, usersById) {
  const client = message.clientId ? usersById.get(message.clientId) : null;
  let media = [];
  if (message.mediaJson) {
    try { media = JSON.parse(message.mediaJson); } catch { media = []; }
  }
  return {
    id: message.id,
    channel: message.channel,
    direction: message.direction,
    fromNumber: message.fromNumber,
    toNumber: message.toNumber,
    body: message.body,
    status: message.status,
    deliveryStatus: message.deliveryStatus || null,
    deliveryError: message.deliveryError || null,
    createdAt: message.createdAt,
    clientId: message.clientId || null,
    clientName: client ? client.name : null,
    clientCompany: client ? client.company || null : null,
    senderLabel: intake.senderLabel(message, client),
    summary: message.aiSummary || null,
    intent: message.aiIntent || null,
    priority: message.aiPriority || null,
    category: message.aiCategory || null,
    ticketId: message.ticketId || null,
    mediaCount: media.length,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;

    const [messages, users] = await Promise.all([
      db.all('sms_messages'),
      db.all('users'),
    ]);
    const usersById = new Map(users.map((u) => [u.id, u]));

    const rows = messages
      .filter((m) => (status ? m.status === status : true))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 200)
      .map((m) => present(m, usersById));

    res.json({
      messages: rows,
      unread: messages.filter((m) => m.status === 'new').length,
      // The page explains itself when a piece is missing rather than silently
      // showing an empty inbox that looks like "no client has ever texted".
      config: {
        twilioReady: twilio.isEnabled(),
        outboundEnabled: twilio.outboundEnabled(),
        triageReady: require('../utils/smsTriage').isEnabled(),
        number: twilio.fromNumber() || null,
        slackReady: slack.isEnabled(),
        // Whether a staff reply typed in Slack can reach a customer at all --
        // distinct from slackReady, which only covers posting *into* Slack.
        slackReplyReady: slack.isEventsEnabled(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Mark read or archived, or link an unknown number to a client. */
router.patch('/:id', requireCSRF, async (req, res, next) => {
  try {
    const message = await db.find('sms_messages', req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const patch = {};

    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
      }
      patch.status = req.body.status;
    }

    if (req.body.clientId !== undefined) {
      if (req.body.clientId === null) {
        patch.clientId = null;
      } else {
        const client = await db.find('users', req.body.clientId);
        if (!client || client.role !== 'client') {
          return res.status(400).json({ error: 'That is not a client account.' });
        }
        patch.clientId = client.id;

        // Linking a number is also how a client's phone gets on file, so the
        // next text from it matches on its own. Only filled when blank: an
        // admin correcting one message must not rewrite the account's number.
        if (!client.phone && message.fromNumber) {
          const normalized = twilio.normalizePhone(message.fromNumber);
          if (normalized) await db.update('users', client.id, { phone: normalized });
        }

        // The Slack thread this number was already texting into (if any) must
        // not be orphaned by linking it to an account after the fact.
        const linkedNumber = twilio.normalizePhone(message.fromNumber);
        if (linkedNumber) await conversations.getOrCreate({ phoneNumber: linkedNumber, clientId: client.id });
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const updated = await db.update('sms_messages', message.id, patch);
    await audit(req.user.id, 'sms.update', 'sms_message', message.id, patch);

    // Look the client up so the row comes back named, rather than reading as
    // "Unknown sender" until the next refetch lands.
    const linked = updated.clientId ? await db.find('users', updated.clientId) : null;
    res.json({ message: present(updated, new Map(linked ? [[linked.id, linked]] : [])) });
  } catch (err) {
    next(err);
  }
});

/** Promote one message into a real ticket. Always a human's decision. */
router.post('/:id/ticket', requireCSRF, async (req, res, next) => {
  try {
    const message = await db.find('sms_messages', req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.ticketId) {
      return res.status(409).json({ error: 'This message is already a ticket.', ticketId: message.ticketId });
    }

    const ticket = await intake.promoteToTicket(message, req.user, {
      subject: typeof req.body.subject === 'string' ? req.body.subject : undefined,
      priority: typeof req.body.priority === 'string' ? req.body.priority : undefined,
      category: typeof req.body.category === 'string' ? req.body.category : undefined,
    });

    await audit(req.user.id, 'sms.promote', 'sms_message', message.id, { ticketId: ticket.id });
    res.status(201).json({ ticket });
  } catch (err) {
    next(err);
  }
});

/**
 * Text a client back.
 *
 * Refuses cleanly while SMS_OUTBOUND_ENABLED is off, which is the state until
 * the number's A2P 10DLC campaign is approved. The 503 carries the reason so
 * the page can say why the button is disabled instead of just failing.
 */
router.post('/:id/reply', requireCSRF, async (req, res, next) => {
  try {
    if (!twilio.outboundEnabled()) {
      return res.status(503).json({
        error: 'Replying by SMS is switched off until the number is registered for A2P 10DLC.',
        outboundDisabled: true,
      });
    }

    const message = await db.find('sms_messages', req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'A reply cannot be empty.' });

    // Sent either way, and the row is kept either way: a Twilio failure must
    // read as a failed message in the thread, never as a reply that vanished.
    const sid = await twilio.sendSms({ to: message.fromNumber, body });

    const sent = await db.insert('sms_messages', {
      provider: 'twilio',
      providerSid: sid || null,
      channel: message.channel,
      direction: 'outbound',
      fromNumber: twilio.fromNumber(),
      toNumber: message.fromNumber,
      body,
      numMedia: 0,
      clientId: message.clientId || null,
      status: 'read',
      deliveryStatus: sid ? 'sent' : 'failed',
      deliveryError: sid ? null : 'Twilio would not accept the message. Check the server log.',
      createdAt: new Date().toISOString(),
    });

    // Keep the customer's Slack thread a complete record of the conversation
    // regardless of which surface staff replied from -- best-effort, since a
    // Slack outage must not undo a text that already went out.
    if (sid) {
      const normalized = twilio.normalizePhone(message.fromNumber);
      const conversation = normalized ? await conversations.findByPhone(normalized) : null;
      if (conversation?.slackChannelId && conversation?.slackThreadTs) {
        try {
          await slack.replyInThread({
            channelId: conversation.slackChannelId,
            threadTs: conversation.slackThreadTs,
            text: `*Reply sent from the dashboard:*\n${body}`,
          });
        } catch (err) {
          console.error(`Could not echo dashboard reply ${sent.id} into Slack:`, err.message);
        }
      }
    }

    await audit(req.user.id, 'sms.reply', 'sms_message', message.id, { sid: sid || null, delivered: Boolean(sid) });

    const linked = sent.clientId ? await db.find('users', sent.clientId) : null;
    const presented = present(sent, new Map(linked ? [[linked.id, linked]] : []));

    if (!sid) {
      return res.status(502).json({ error: 'Twilio would not accept the message. The attempt was recorded.', message: presented });
    }
    res.status(201).json({ message: presented });
  } catch (err) {
    next(err);
  }
});

/**
 * Text the same message to a chosen list of clients.
 *
 * Deliberately an explicit list, never "all clients" -- a broadcast is the
 * one action in this file that reaches more than one person per click, and
 * the recipient list is the whole safeguard against sending to somebody by
 * mistake.
 *
 * Sent one at a time, not in parallel: Twilio rate-limits a number's outbound
 * traffic, and a batch racing itself against that limit is not worth the
 * couple of seconds saved. One bad recipient (no phone on file, a Twilio
 * failure) is recorded and skipped -- it never stops the rest of the list.
 */
router.post('/broadcast', requireCSRF, async (req, res, next) => {
  try {
    if (!twilio.outboundEnabled()) {
      return res.status(503).json({
        error: 'Sending SMS is switched off until the number is registered for A2P 10DLC.',
        outboundDisabled: true,
      });
    }

    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'A broadcast message cannot be empty.' });

    const clientIds = Array.isArray(req.body.clientIds)
      ? [...new Set(req.body.clientIds.filter((id) => typeof id === 'string' && id))]
      : [];
    if (clientIds.length === 0) return res.status(400).json({ error: 'Pick at least one recipient.' });

    const broadcast = await db.insert('sms_broadcasts', {
      body,
      createdBy: req.user.id,
      recipientCount: clientIds.length,
      createdAt: new Date().toISOString(),
    });

    const results = [];
    for (const clientId of clientIds) {
      const client = await db.find('users', clientId);
      if (!client || client.role !== 'client') {
        results.push({ clientId, status: 'failed', error: 'Not a client account.' });
        continue;
      }

      const to = twilio.normalizePhone(client.phone);
      if (!to) {
        results.push({ clientId, status: 'failed', error: 'No phone number on file.' });
        continue;
      }

      const conversation = await conversations.getOrCreate({ phoneNumber: to, clientId: client.id });
      const sid = await twilio.sendSms({ to, body });
      const deliveryError = sid ? null : 'Twilio would not accept the message. Check the server log.';

      const sent = await db.insert('sms_messages', {
        provider: 'twilio',
        providerSid: sid || null,
        channel: 'sms',
        direction: 'outbound',
        fromNumber: twilio.fromNumber(),
        toNumber: to,
        body,
        numMedia: 0,
        clientId: client.id,
        broadcastId: broadcast.id,
        status: 'read',
        deliveryStatus: sid ? 'sent' : 'failed',
        deliveryError,
        createdAt: new Date().toISOString(),
      });

      // Same best-effort echo as a single reply: only into a thread that
      // already exists, never opening a new one for a broadcast.
      if (sid && conversation?.slackChannelId && conversation?.slackThreadTs) {
        try {
          await slack.replyInThread({
            channelId: conversation.slackChannelId,
            threadTs: conversation.slackThreadTs,
            text: `*Broadcast sent from the dashboard:*\n${body}`,
          });
        } catch (err) {
          console.error(`Could not echo broadcast message ${sent.id} into Slack:`, err.message);
        }
      }

      live.publish('sms');
      results.push({ clientId, status: sid ? 'sent' : 'failed', error: deliveryError });
    }

    await audit(req.user.id, 'sms.broadcast', 'sms_broadcast', broadcast.id, {
      recipientCount: clientIds.length,
      sent: results.filter((r) => r.status === 'sent').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });

    res.status(201).json({ broadcastId: broadcast.id, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.webhookHandler = webhookHandler;
