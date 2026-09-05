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
    fromNumber: message.fromNumber,
    body: message.body,
    status: message.status,
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

    const sid = await twilio.sendSms({ to: message.fromNumber, body });
    if (!sid) return res.status(502).json({ error: 'Twilio would not accept the message. Check the server log.' });

    const sent = await db.insert('sms_messages', {
      provider: 'twilio',
      providerSid: sid,
      channel: message.channel,
      direction: 'outbound',
      fromNumber: twilio.fromNumber(),
      toNumber: message.fromNumber,
      body,
      numMedia: 0,
      clientId: message.clientId || null,
      status: 'read',
      createdAt: new Date().toISOString(),
    });

    await audit(req.user.id, 'sms.reply', 'sms_message', message.id, { sid });

    const linked = sent.clientId ? await db.find('users', sent.clientId) : null;
    res.status(201).json({ message: present(sent, new Map(linked ? [[linked.id, linked]] : [])) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.webhookHandler = webhookHandler;
