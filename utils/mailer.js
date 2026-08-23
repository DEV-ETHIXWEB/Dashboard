'use strict';

/**
 * Outbound email.
 *
 * Three real transports, auto-detected in this order (or forced with
 * MAIL_TRANSPORT=smtp|resend|webhook):
 *   1. SMTP_HOST        -> any mailbox you already own: Gmail, Zoho, Outlook,
 *                          Amazon SES, your own server. Uses nodemailer.
 *   2. RESEND_API_KEY   -> Resend HTTPS API
 *   3. MAIL_WEBHOOK_URL -> POST {to, subject, text, html} to your own endpoint
 *
 * With none of them set nothing is delivered; the message is still rendered
 * and written to `email_log` as "held", so an admin can review every template
 * on the Mail page before a single credential exists. That is a fallback for a
 * fresh install, not the end state -- the Mail page says so plainly.
 *
 * Every attempt is written to `email_log`, delivered or not.
 *
 * sendMail never throws. A ticket that was saved must never be reported as
 * failed because an inbox was unreachable.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { LOGO_CID, LOGO_SRC, ICON_CID_PREFIX, ICONS } = require('./emailTemplates');

const MAX_LOG_HTML = 400_000; // a rendered email is ~20KB; this is a sanity cap

const LOGO_PATH = path.join(__dirname, '..', 'public', 'ethixweb.png');
const cache = new Map();

/**
 * The wordmark, as base64, read once and kept.
 *
 * It travels with the message rather than being linked, because a linked image
 * needs a publicly reachable URL and a deployment on a laptop has none -- the
 * header would fall back to bare text in every inbox. Returns null if the file
 * is missing, and the header then degrades to that text rather than a broken
 * image.
 */
function readImage(filePath, filename, cid) {
  if (!cache.has(filePath)) {
    try {
      cache.set(filePath, fs.readFileSync(filePath).toString('base64'));
    } catch (err) {
      console.warn(`[mail] Could not read ${filePath}: ${err.message}`);
      cache.set(filePath, '');
    }
  }
  const base64 = cache.get(filePath);
  return base64 ? { filename, contentType: 'image/png', base64, cid } : null;
}

function logoAttachment() {
  return readImage(LOGO_PATH, 'ethixweb.png', LOGO_CID);
}

/**
 * Only attach the wordmark to messages whose HTML actually references it, so a
 * plain-text-only send stays plain text. One file covers the masthead mark, the
 * wash behind it, and the footer sign-off, so there is only ever one of these.
 */
function inlineImagesFor(html) {
  if (!html) return [];
  const out = [];
  if (html.includes(LOGO_SRC)) {
    const logo = logoAttachment();
    if (logo) out.push(logo);
  }
  // Only the glyphs this message actually names: a short email stays short.
  for (const name of ICONS) {
    const cid = ICON_CID_PREFIX + name;
    if (!html.includes('cid:' + cid)) continue;
    const img = readImage(path.join(__dirname, '..', 'public', 'mail-icons', name + '.png'), name + '.png', cid);
    if (img) out.push(img);
  }
  return out;
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function isEnabled() {
  return transportName() !== 'none';
}

/**
 * Which transport this deployment will actually use. MAIL_TRANSPORT forces one
 * (useful when several are configured); otherwise the first configured wins.
 */
function transportName() {
  const forced = String(process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (forced === 'smtp') return smtpConfigured() ? 'smtp' : 'none';
  if (forced === 'resend') return process.env.RESEND_API_KEY ? 'resend' : 'none';
  if (forced === 'webhook') return process.env.MAIL_WEBHOOK_URL ? 'webhook' : 'none';

  if (smtpConfigured()) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.MAIL_WEBHOOK_URL) return 'webhook';
  return 'none';
}

/** 465 is implicit TLS; 587 and 25 start plaintext and upgrade with STARTTLS. */
function smtpSecure(port) {
  const explicit = process.env.SMTP_SECURE;
  if (explicit !== undefined && explicit !== '') return String(explicit).toLowerCase() === 'true';
  return Number(port) === 465;
}

/** Everything an admin needs to see about the SMTP side, minus the password. */
function smtpSummary() {
  if (!smtpConfigured()) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host: process.env.SMTP_HOST,
    port,
    secure: smtpSecure(port),
    user: process.env.SMTP_USER || null,
    hasPassword: Boolean(process.env.SMTP_PASSWORD),
  };
}

let transporter = null;
let transporterKey = null;

/**
 * One pooled connection per configuration. Rebuilt if the environment changes,
 * which matters for tests more than for production.
 */
function getSmtpTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  const key = [
    process.env.SMTP_HOST, port, process.env.SMTP_USER, process.env.SMTP_PASSWORD,
    process.env.SMTP_SECURE, process.env.SMTP_ALLOW_SELF_SIGNED,
  ].join('|');

  if (transporter && transporterKey === key) return transporter;
  if (transporter) transporter.close();

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: smtpSecure(port),
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    // Only for a self-hosted server with a self-signed certificate. Never
    // switch this on for a public provider.
    tls: String(process.env.SMTP_ALLOW_SELF_SIGNED).toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
  });
  transporterKey = key;
  return transporter;
}

/** Prove the credentials work without sending anything. */
async function verifyTransport() {
  const name = transportName();
  if (name === 'none') return { ok: false, transport: 'none', error: 'No email transport is configured.' };
  if (name !== 'smtp') return { ok: true, transport: name, note: 'This transport is checked when a message is sent.' };
  try {
    await getSmtpTransport().verify();
    return { ok: true, transport: 'smtp' };
  } catch (err) {
    return { ok: false, transport: 'smtp', error: err.message };
  }
}

function fromAddress() {
  return process.env.MAIL_FROM || 'EthixWeb Dashboard <onboarding@resend.dev>';
}

/** Extra inboxes that get "tell the admins" mail, on top of admin accounts. */
function adminRecipients() {
  return (process.env.ADMIN_ALERT_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAddress(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Real addresses only, de-duplicated case-insensitively, order preserved. */
function cleanRecipients(to) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean).map((s) => String(s).trim());
  const seen = new Set();
  const out = [];
  for (const address of list) {
    if (!isAddress(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

async function sendViaSmtp({ to, subject, text, html }) {
  const images = inlineImagesFor(html);
  const info = await getSmtpTransport().sendMail({
    from: fromAddress(),
    to: to.join(', '),
    subject,
    text,
    html: html || undefined,
    attachments: images.length > 0
      ? images.map((img) => ({
        filename: img.filename, content: img.base64, encoding: 'base64', contentType: img.contentType, cid: img.cid,
      }))
      : undefined,
  });
  if (info.rejected && info.rejected.length > 0) {
    throw new Error(`The server rejected ${info.rejected.join(', ')}`);
  }
  return { ok: true, transport: 'smtp', providerId: info.messageId || null };
}

async function sendViaResend({ to, subject, text, html }) {
  const images = inlineImagesFor(html);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to,
      subject,
      text,
      html: html || undefined,
      // Resend's own field names for an inline attachment's Content-Id.
      attachments: images.length > 0
        ? images.map((img) => ({
          filename: img.filename, content: img.base64, content_type: img.contentType, content_id: img.cid,
        }))
        : undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend rejected the message (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, transport: 'resend', providerId: data.id || null };
}

async function sendViaWebhook({ to, subject, text, html }) {
  const res = await fetch(process.env.MAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.MAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ from: fromAddress(), to, subject, text, html }),
  });
  if (!res.ok) throw new Error(`Mail webhook returned ${res.status}`);
  return { ok: true, transport: 'webhook', providerId: null };
}

/**
 * Templates whose body is never kept.
 *
 * The Mail page stores every message in full so an admin can see exactly what
 * went out, which is the right idea for a ticket update and the wrong one for
 * a credential. A welcome email contains the plaintext temporary password and
 * a working one-tap sign-in link; a sign-in code email contains the code. Kept
 * on the Mail page, those became a permanent, browsable store of live
 * credentials that every administrator could open.
 *
 * The row still exists -- who it went to, when, whether it was delivered --
 * because that is what the page is for. Only the body is dropped.
 */
const UNLOGGED_BODIES = new Set(['credentials', 'login_code']);

/**
 * Belt and braces for every other template: a sign-in token that finds its way
 * into some future email must not be replayable out of the log either.
 */
function scrubStoredHtml(html) {
  return String(html || '').replace(
    /(magic-link\/verify\?token=)[^"'&\s<]+/gi,
    '$1[redacted]',
  );
}

/** What is safe to keep of this message's body. */
function storableHtml(entry) {
  if (UNLOGGED_BODIES.has(entry.template)) return null;
  const scrubbed = scrubStoredHtml(entry.html).slice(0, MAX_LOG_HTML);
  return scrubbed || null;
}

/**
 * Record what happened. Logging is best-effort too: a missing table on an old
 * deployment must not turn a delivered email into a thrown error.
 */
async function logEmail(entry) {
  try {
    // The Mail page used to poll every 30 seconds to notice a send. It does
    // not need to: this is the moment a send becomes a fact.
    require('./liveBus').publish('mail');
    // Required lazily so requiring the mailer never pulls in a database
    // connection -- template previews and tests do not need one.
    const { db } = require('../db/setup');
    await db.insert('email_log', {
      id: uuidv4(),
      toEmails: entry.to.join(', '),
      subject: entry.subject || '',
      template: entry.template || 'custom',
      status: entry.status,
      transport: entry.transport || transportName(),
      error: entry.error || null,
      entity: entry.entity || null,
      entityId: entry.entityId || null,
      html: storableHtml(entry),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Could not write the email log entry:', err.message);
  }
}

/**
 * Send a message. Never throws -- failures are logged and reported in the
 * return value so callers can stay on the happy path.
 *
 * `template`, `entity`, and `entityId` are metadata for the Mail page only.
 */
/**
 * A test inbox to send everything to instead of the real recipient.
 *
 * Resend's sandbox, and most providers' free tiers, refuse any address except
 * the account owner's. Without this the whole app looks broken in testing:
 * every client email fails with a provider error that has nothing to do with
 * the app. Set MAIL_REDIRECT_TO and outbound mail goes to that one inbox with
 * the intended recipient named in the subject, so the flow can still be walked
 * end to end. Unset in production and nothing about delivery changes.
 */
function redirectTo() {
  const value = String(process.env.MAIL_REDIRECT_TO || '').trim();
  return isAddress(value) ? value : null;
}

/**
 * Provider errors, in words the person reading them can act on.
 *
 * A 403 from Resend arrives as a JSON blob about domain verification. Dropping
 * that into a toast tells an admin nothing they can use; the raw text still
 * goes to the mail log, where somebody debugging will look for it.
 */
function explainSendError(message) {
  const raw = String(message || '');

  if (/only send testing emails to your own email address/i.test(raw)) {
    const own = raw.match(/\(([^)]+@[^)]+)\)/)?.[1];
    return `Your email provider is still in test mode: it will only deliver to ${own || 'the account owner'}. `
      + 'Verify a sending domain, or set MAIL_REDIRECT_TO to that address to keep testing.';
  }
  if (/\b(401|403)\b/.test(raw) && /api[_ ]?key|unauthor/i.test(raw)) {
    return 'The email provider refused our credentials. Check the API key.';
  }
  if (/domain is not verified|not verified/i.test(raw)) {
    return 'The sending domain is not verified with the email provider yet.';
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(raw)) {
    return 'The email provider is rate limiting us. Try again shortly.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i.test(raw)) {
    return 'Could not reach the mail server. Check the host and port.';
  }
  if (/Invalid login|authentication failed|535/i.test(raw)) {
    return 'The mail server rejected our username or password.';
  }
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

async function sendMail({ to, subject, text, html, template, entity, entityId }) {
  const requested = cleanRecipients(to);
  if (requested.length === 0) return { ok: false, skipped: 'no valid recipients' };

  // The log always records who the message was *for*, even when a test inbox
  // is where it physically went -- otherwise the record is a lie.
  const redirect = redirectTo();
  const recipients = redirect ? [redirect] : requested;
  const outSubject = redirect ? `[to: ${requested.join(', ')}] ${subject}` : subject;

  const transport = transportName();
  if (transport === 'none') {
    await logEmail({
      to: recipients, subject, html, template, entity, entityId,
      status: 'skipped',
      transport: 'none',
      error: 'No email transport configured (set SMTP_HOST, RESEND_API_KEY, or MAIL_WEBHOOK_URL)',
    });
    return { ok: false, skipped: 'email transport not configured', recipients };
  }

  try {
    const send = { smtp: sendViaSmtp, resend: sendViaResend, webhook: sendViaWebhook }[transport];
    const result = await send({ to: recipients, subject: outSubject, text, html });
    await logEmail({
      to: requested, subject, html, template, entity, entityId,
      status: 'sent',
      transport: result.transport,
      error: redirect ? `Redirected to ${redirect} by MAIL_REDIRECT_TO` : null,
    });
    return { ...result, recipients: requested, redirectedTo: redirect };
  } catch (err) {
    const friendly = explainSendError(err.message);
    // Short line for a person, full text for whoever debugs it later.
    console.error('Email send failed:', friendly);
    await logEmail({ to: requested, subject, html, template, entity, entityId, status: 'failed', error: err.message });
    return { ok: false, error: friendly, detail: err.message, recipients: requested };
  }
}

/**
 * Send one of the templates in utils/emailMessages.js.
 *
 * `message` is the `{ subject, html, text }` a template returned, so the call
 * site reads as "render this, send it to these people".
 */
async function sendTemplate({ to, message, template, entity, entityId }) {
  if (!message || !message.subject) return { ok: false, skipped: 'no message' };
  return sendMail({
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    template,
    entity,
    entityId,
  });
}

/** Newest first, for the admin Mail page. */
async function recentLog(limit = 100) {
  const { db } = require('../db/setup');
  const rows = await db.all('email_log');
  return rows
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

module.exports = {
  redirectTo,
  explainSendError,
  isEnabled,
  transportName,
  smtpConfigured,
  smtpSummary,
  verifyTransport,
  sendMail,
  sendTemplate,
  adminRecipients,
  cleanRecipients,
  isAddress,
  fromAddress,
  recentLog,
};
