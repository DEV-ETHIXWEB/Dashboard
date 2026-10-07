'use strict';

/**
 * Outbound email.
 *
 * Three real transports, auto-detected in this order (or forced with
 * MAIL_TRANSPORT=smtp2go|smtp|webhook):
 *   1. SMTP2GO_API_KEY  -> SMTP2GO HTTPS API (what this deployment uses)
 *   2. SMTP_HOST        -> any mailbox you already own: Gmail, Zoho, Outlook,
 *                          Amazon SES, SMTP2GO's own relay. Uses nodemailer.
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

function smtp2goConfigured() {
  return Boolean(String(process.env.SMTP2GO_API_KEY || '').trim());
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
  if (forced === 'smtp2go') return smtp2goConfigured() ? 'smtp2go' : 'none';
  if (forced === 'smtp') return smtpConfigured() ? 'smtp' : 'none';
  if (forced === 'webhook') return process.env.MAIL_WEBHOOK_URL ? 'webhook' : 'none';

  // SMTP2GO's API wins over a bare SMTP_HOST: an outbound SMTP port is the
  // thing most likely to be blocked on a serverless host, and this deployment
  // runs on Vercel.
  if (smtp2goConfigured()) return 'smtp2go';
  if (smtpConfigured()) return 'smtp';
  if (process.env.MAIL_WEBHOOK_URL) return 'webhook';
  return 'none';
}

/**
 * Every configured transport, best first.
 *
 * `transportName` answers "which one will be used", which was the only
 * question while a send was one attempt. It is the wrong question now: a
 * deployment with SMTP2GO *and* an SMTP mailbox configured had the second one
 * sitting there unused while a single SMTP2GO outage dropped every message.
 * The order is the same preference `transportName` applies -- it is the first
 * element of this list -- and `sendNow` walks the rest when the first one
 * fails for a reason that is about the transport rather than the recipient.
 *
 * Forcing MAIL_TRANSPORT still means exactly one: an admin who named a
 * transport does not want mail quietly leaving by another route.
 */
function transportChain() {
  const forced = String(process.env.MAIL_TRANSPORT || '').trim().toLowerCase();
  if (forced) {
    const one = transportName();
    return one === 'none' ? [] : [one];
  }
  const chain = [];
  if (smtp2goConfigured()) chain.push('smtp2go');
  if (smtpConfigured()) chain.push('smtp');
  if (process.env.MAIL_WEBHOOK_URL) chain.push('webhook');
  return chain;
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
  if (name === 'smtp2go') return verifySmtp2go();
  if (name !== 'smtp') return { ok: true, transport: name, note: 'This transport is checked when a message is sent.' };
  try {
    await getSmtpTransport().verify();
    return { ok: true, transport: 'smtp' };
  } catch (err) {
    return { ok: false, transport: 'smtp', error: err.message };
  }
}

/**
 * Prove the API key without sending anything.
 *
 * The stats endpoint is the cheapest authenticated call SMTP2GO has: it takes
 * the same key and sends no mail, so "Verify connection" on the Mail page
 * answers the only question an admin has before the first real send.
 */
async function verifySmtp2go() {
  const base = SMTP2GO_ENDPOINT.replace(/\/email\/send$/, '');
  try {
    const res = await fetch(`${base}/stats/email_summary`, {
      method: 'POST',
      headers: {
        'X-Smtp2go-Api-Key': String(process.env.SMTP2GO_API_KEY || '').trim(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    });
    if (res.ok) return { ok: true, transport: 'smtp2go' };
    const body = await res.text().catch(() => '');
    return { ok: false, transport: 'smtp2go', error: explainSendError(`SMTP2GO (${res.status}): ${body.slice(0, 200)}`) };
  } catch (err) {
    return { ok: false, transport: 'smtp2go', error: `Could not reach SMTP2GO: ${err.message}` };
  }
}

/**
 * Where a reply goes.
 *
 * The From address is a noreply, which is correct for a sender nobody should
 * write to -- but several of these messages tell the client in as many words to
 * "just reply to this email", and a promise like that has to land somewhere a
 * person reads. Set MAIL_REPLY_TO to the inbox your team actually watches.
 *
 * Unset, no Reply-To header is added and replies go to the From address, which
 * is the behaviour this app had before. That is a silent dead end, so the
 * startup check in server.js says so out loud.
 */
function replyToAddress() {
  const value = String(process.env.MAIL_REPLY_TO || '').trim();
  return value && isAddress(value.replace(/^.*</, '').replace(/>.*$/, '')) ? value : null;
}

function fromAddress() {
  return process.env.MAIL_FROM || 'EthixWeb Dashboard <noreply@ethixwebdashboard.com>';
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
  const reply = replyToAddress();
  const info = await getSmtpTransport().sendMail({
    from: fromAddress(),
    ...(reply ? { replyTo: reply } : {}),
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

const SMTP2GO_ENDPOINT = process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send';

/**
 * SMTP2GO over HTTPS.
 *
 * Chosen over SMTP2GO's SMTP relay because this app is deployed on Vercel,
 * where an outbound connection on 587/465 is the first thing to go missing;
 * an HTTPS POST always works. The SMTP path below still exists, so pointing
 * SMTP_HOST at mail.smtp2go.com with an SMTP user is a supported fallback.
 *
 * Inline artwork: SMTP2GO derives each part's Content-ID from the attachment
 * filename, so the filename here is the bare cid the HTML already references
 * (`cid:ethixweb-logo`), not `ethixweb-logo.png`. The mimetype carries the
 * type instead. Rename one and the masthead silently falls back to alt text.
 */
async function sendViaSmtp2go({ to, subject, text, html }) {
  const images = inlineImagesFor(html);
  const res = await fetch(SMTP2GO_ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Smtp2go-Api-Key': String(process.env.SMTP2GO_API_KEY || '').trim(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: fromAddress(),
      ...(replyToAddress() ? { reply_to: replyToAddress() } : {}),
      to,
      subject,
      text_body: text,
      html_body: html || undefined,
      attachments: images.length > 0
        ? images.map((img) => ({
          filename: img.cid, fileblob: img.base64, mimetype: img.contentType,
        }))
        : undefined,
    }),
  });

  const body = await res.text().catch(() => '');
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { /* keep the raw text for the message below */ }

  if (!res.ok) {
    throw new Error(`SMTP2GO rejected the message (${res.status}): ${describeSmtp2goFailure(data) || body.slice(0, 200)}`);
  }

  // A 200 is not delivery: SMTP2GO reports per-recipient failures in the body,
  // so a bad address or an unverified sender would otherwise be logged as sent.
  const payload = data.data || {};
  if (Number(payload.succeeded || 0) === 0) {
    throw new Error(`SMTP2GO accepted nothing: ${describeSmtp2goFailure(data) || body.slice(0, 200)}`);
  }
  return { ok: true, transport: 'smtp2go', providerId: payload.email_id || null };
}

/** Pull the useful sentence out of SMTP2GO's error shape. */
function describeSmtp2goFailure(data) {
  const parts = [];
  if (data?.data?.error) parts.push(data.data.error);
  if (data?.data?.error_code) parts.push(`(${data.data.error_code})`);
  const failures = data?.data?.failures;
  if (Array.isArray(failures) && failures.length > 0) parts.push(failures.join('; '));
  if (data?.error) parts.push(data.error);
  return parts.join(' ').trim();
}

async function sendViaWebhook({ to, subject, text, html }) {
  const res = await fetch(process.env.MAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.MAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ from: fromAddress(), replyTo: replyToAddress(), to, subject, text, html }),
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
 * Templates that are never queued.
 *
 * Each of these carries something that works: a plaintext password, a sign-in
 * code, a link that sets a password. Putting one in the outbox would store a
 * live credential in a table, in a `payload` column, for as long as the retry
 * schedule takes -- which is the thing `UNLOGGED_BODIES` above exists to stop
 * happening in `email_log`. Doing it in a second table would be worse, because
 * that one is written on the way *in*, before anybody knows the send worked.
 *
 * Retrying them is also close to pointless. A sign-in code is valid for a few
 * minutes, so the fourth attempt six hours later delivers an expired number to
 * somebody who gave up and asked for another one. These flows all have a
 * person waiting at a screen, and what helps them is an immediate answer and a
 * second transport to try -- both of which `sendNow` gives them.
 */
const NEVER_QUEUED = new Set(['credentials', 'login_code', 'account_activation', 'password_reset']);

/**
 * Whether a provider's refusal is about this message or about this moment.
 *
 * Only used to decide whether walking to the next transport is worth trying.
 * A connection that was refused, a timeout, a rate limit or a 5xx is the
 * moment, and another provider may well take the message. A rejected
 * recipient, a trial-mode account or an unverified sending domain is the
 * message or the configuration, and every transport in the chain will say the
 * same thing -- so stopping is both faster and quieter than proving it twice.
 */
function worthAnotherTransport(message) {
  const raw = String(message || '');
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|ECONNRESET|socket hang up/i.test(raw)) return true;
  if (/rate.?limit|too many requests|\b429\b/i.test(raw)) return true;
  if (/\b5\d\d\b/.test(raw)) return true;
  if (/could not reach/i.test(raw)) return true;
  return false;
}

/**
 * Whether no transport will ever accept this, so the outbox should stop.
 *
 * Mirrors `worthAnotherTransport` from the other side and is read by
 * utils/outbox.js through the `permanent` flag on a failed result.
 */
function isPermanentFailure(message) {
  const raw = String(message || '');
  if (/only send testing emails to your own email address/i.test(raw)) return true;
  if (/domain is not verified|not verified|sender[^.]*(not allowed|denied)|SENDER_/i.test(raw)) return true;
  if (/\b(401|403)\b|api[_ ]?key|unauthor|AUTHENTICATION/i.test(raw)) return true;
  if (/Invalid login|authentication failed|535/i.test(raw)) return true;
  if (/The server rejected /i.test(raw)) return true;
  return false;
}

/**
 * Belt and braces for every other template: a sign-in token that finds its way
 * into some future email must not be replayable out of the log either.
 */
function scrubStoredHtml(html) {
  return String(html || '')
    .replace(/(magic-link\/verify\?token=)[^"'&\s<]+/gi, '$1[redacted]')
    // Activation and password-reset links carry their token in the URL
    // fragment, so it never reaches a server log on its own -- but the message
    // body is a copy of the whole URL, and storing that would put a live
    // password-setup link on the Mail page for any admin to open. The rendered
    // email keeps its shape here; only the secret goes.
    .replace(/(set-password#token=)[^"'&\s<]+/gi, '$1[redacted]');
}

/**
 * Whether this body contains something that works.
 *
 * The same two patterns `scrubStoredHtml` redacts, asked as a question. If the
 * body would lose something to that scrub, it is not a body to hold in a queue
 * -- the queue has to keep the real thing, because a redacted link in a sent
 * email is worse than no email.
 */
function carriesSecret(html) {
  return scrubStoredHtml(html) !== String(html || '');
}

/** What is safe to keep of this message's body. */
function storableHtml(entry) {
  if (UNLOGGED_BODIES.has(entry.template)) return null;
  const scrubbed = scrubStoredHtml(entry.html).slice(0, MAX_LOG_HTML);
  return scrubbed || null;
}

/**
 * What is safe to keep of this message's subject.
 *
 * Withholding the body of a sign-in email is only half the job: the subject
 * leads with the code, because someone mid-login reads it off the notification
 * without opening anything. Stored as-is, that put every live code on the Mail
 * page, readable by any admin -- passively, unaudited, and unrate-limited,
 * which is weaker than the reveal endpoint that exists for exactly this and is
 * held to trusted admins. The inbox still gets the code; the log does not.
 */
function storableSubject(entry) {
  const subject = String(entry.subject || '');
  if (!UNLOGGED_BODIES.has(entry.template)) return subject;
  return subject.replace(/\b\d{6}\b/g, '[redacted]');
}

/**
 * Record what happened. Logging is best-effort too: a missing table on an old
 * deployment must not turn a delivered email into a thrown error.
 *
 * Returns the row's id, so a queued message can come back and finish the same
 * row rather than writing a second one -- see `logId` below. Returns null when
 * the write failed, and callers treat that as "no row to update".
 */
async function logEmail(entry) {
  try {
    // The Mail page used to poll every 30 seconds to notice a send. It does
    // not need to: this is the moment a send becomes a fact.
    require('./liveBus').publish('mail');
    // Required lazily so requiring the mailer never pulls in a database
    // connection -- template previews and tests do not need one.
    const { db } = require('../db/setup');
    const id = uuidv4();
    await db.insert('email_log', {
      id,
      toEmails: entry.to.join(', '),
      subject: storableSubject(entry),
      template: entry.template || 'custom',
      status: entry.status,
      transport: entry.transport || transportName(),
      error: entry.error || null,
      entity: entry.entity || null,
      entityId: entry.entityId || null,
      html: storableHtml(entry),
      createdAt: new Date().toISOString(),
    });
    return id;
  } catch (err) {
    console.error('Could not write the email log entry:', err.message);
    return null;
  }
}

/**
 * Finish the row a queued message already has.
 *
 * Queueing writes the `email_log` row immediately, because the Mail page is
 * where an admin looks to find out whether something went out and a message
 * that is invisible for two minutes reads as a message that was never sent.
 * The row then has to be *completed* rather than duplicated, or every queued
 * email would appear twice -- once as queued, once as sent -- and a message
 * that retried four times would appear five times.
 *
 * Best-effort, like the insert above, and for the same reason.
 */
async function updateLog(id, patch) {
  if (!id) return;
  try {
    require('./liveBus').publish('mail');
    const { db } = require('../db/setup');
    await db.update('email_log', id, patch);
  } catch (err) {
    console.error('Could not update the email log entry:', err.message);
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
 * A provider's trial mode, or a sending domain that is not verified yet, can
 * refuse every address except the account owner's. Without this the whole app looks broken in testing:
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
 * A 4xx from SMTP2GO arrives as a JSON blob with an error_code in it. Dropping
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
  if (/\b(401|403)\b/.test(raw) || /api[_ ]?key|unauthor|API_KEY_INVALID|AUTHENTICATION/i.test(raw)) {
    return 'SMTP2GO refused our credentials. Check that SMTP2GO_API_KEY matches a live key in the SMTP2GO dashboard.';
  }
  if (/domain is not verified|not verified|sender[^.]*(not allowed|denied)|SENDER_/i.test(raw)) {
    return 'SMTP2GO will not send as this address. MAIL_FROM must be on a sender domain verified in SMTP2GO.';
  }
  if (/NON_VALIDATING|E_ApiResponseCodes/i.test(raw)) {
    return `SMTP2GO rejected the request: ${raw.slice(0, 140)}`;
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

const SENDERS = { smtp2go: sendViaSmtp2go, smtp: sendViaSmtp, webhook: sendViaWebhook };

/**
 * Actually put the message on the wire, now, trying each transport in turn.
 *
 * This is the old `sendMail`, with one thing added: when a transport fails for
 * a reason that is about the transport rather than the message, the next
 * configured one gets a go before the attempt is called a failure. A
 * deployment with SMTP2GO and an SMTP mailbox both configured now survives
 * either of them being down, which is the whole reason anybody configures two.
 *
 * Still never throws. Every attempt is written to `email_log` with the
 * transport that made it, so a chain that fell through to its second choice
 * says so on the Mail page rather than looking like one lucky send.
 *
 * `permanent` on a failed result is what utils/outbox.js reads to decide
 * whether retrying this in a minute could possibly help.
 */
async function sendNow({ to, subject, text, html, template, entity, entityId, logId = null }) {
  const requested = cleanRecipients(to);
  if (requested.length === 0) return { ok: false, skipped: 'no valid recipients', permanent: true };

  // A queued message already has its row; an inline one needs a new one each
  // time. `record` hides which case this is from the rest of the function.
  const record = async (entry) => {
    if (logId) return updateLog(logId, { status: entry.status, transport: entry.transport, error: entry.error });
    return logEmail(entry);
  };

  // The log always records who the message was *for*, even when a test inbox
  // is where it physically went -- otherwise the record is a lie.
  const redirect = redirectTo();
  const recipients = redirect ? [redirect] : requested;
  const outSubject = redirect ? `[to: ${requested.join(', ')}] ${subject}` : subject;

  const chain = transportChain();
  if (chain.length === 0) {
    await record({
      to: recipients, subject, html, template, entity, entityId,
      status: 'skipped',
      transport: 'none',
      error: 'No email transport configured (set SMTP2GO_API_KEY, SMTP_HOST, or MAIL_WEBHOOK_URL)',
    });
    // Not permanent: an admin setting SMTP2GO_API_KEY is exactly the kind of
    // thing that happens between one attempt and the next, and a message that
    // was waiting for a transport should go out when one appears.
    return { ok: false, skipped: 'email transport not configured', recipients, permanent: false };
  }

  let lastError = null;

  for (let i = 0; i < chain.length; i += 1) {
    const transport = chain[i];
    try {
      const result = await SENDERS[transport]({ to: recipients, subject: outSubject, text, html });
      await record({
        to: requested, subject, html, template, entity, entityId,
        status: 'sent',
        transport: result.transport,
        error: redirect ? `Redirected to ${redirect} by MAIL_REDIRECT_TO` : null,
      });
      return { ...result, recipients: requested, redirectedTo: redirect };
    } catch (err) {
      lastError = err;
      const another = i + 1 < chain.length && worthAnotherTransport(err.message);
      // An inline send writes one row per transport tried, so the Mail page
      // shows the failover rather than hiding it behind whichever attempt
      // ended up last. A queued one keeps updating its single row: five
      // attempts across two transports is still one message, and the outbox
      // row is where the attempt history lives.
      await record({
        to: requested, subject, html, template, entity, entityId,
        status: 'failed',
        transport,
        error: another ? `${err.message} -- trying ${chain[i + 1]} next` : err.message,
      });
      if (!another) break;
      console.warn(`[mail] ${transport} failed, falling back to ${chain[i + 1]}: ${err.message}`);
    }
  }

  const friendly = explainSendError(lastError && lastError.message);
  // Short line for a person, full text for whoever debugs it later.
  console.error('Email send failed:', friendly);
  return {
    ok: false,
    error: friendly,
    detail: lastError && lastError.message,
    recipients: requested,
    permanent: isPermanentFailure(lastError && lastError.message),
  };
}

/**
 * Send a message. Never throws -- failures are logged and reported in the
 * return value so callers can stay on the happy path.
 *
 * By default this now *queues* the message rather than sending it inline, and
 * `ok: true` means "accepted for delivery" rather than "in the inbox". That is
 * the point: a caller that has just saved a ticket should not be waiting on an
 * SMTP handshake, and a provider blip during that handshake should not be the
 * end of the message. utils/outbox.js carries it from there, retrying with
 * backoff and telling the administrators if it runs out of attempts.
 *
 * Two things still go out inline:
 *
 *   - anything in NEVER_QUEUED, because its contents would be a credential
 *     sitting in a database table, and because it is useless late
 *   - anything the caller asked for with `queue: false`, which is the admin
 *     "send a test email" button: it exists to report what happened, and
 *     "queued" is not an answer to that question
 *
 * `template`, `entity`, and `entityId` are metadata for the Mail page only.
 */
async function sendMail({ to, subject, text, html, template, entity, entityId, queue = true, dedupeKey = null }) {
  let inline = queue === false || NEVER_QUEUED.has(template);

  // NEVER_QUEUED is a list somebody has to remember to add to, and the cost of
  // forgetting is a live credential sitting in a database column for hours.
  // So the rule is also enforced on the message itself: anything that still
  // carries a token after `scrubStoredHtml` would have redacted it is treated
  // as secret-bearing whatever its template is called. A new template that
  // emails a sign-in link is then safe by default rather than safe if
  // somebody noticed.
  if (!inline && carriesSecret(html)) {
    console.warn(
      `[mail] the "${template || 'custom'}" template carries a token, so it was sent inline `
      + 'rather than queued. Add it to NEVER_QUEUED in utils/mailer.js to make that explicit.',
    );
    inline = true;
  }

  if (inline) return sendNow({ to, subject, text, html, template, entity, entityId });

  const requested = cleanRecipients(to);
  if (requested.length === 0) return { ok: false, skipped: 'no valid recipients' };

  try {
    // The Mail page's row exists from this moment, so a message that is
    // waiting is visible as waiting rather than as nothing at all. `sendNow`
    // completes this same row when the sweep gets to it.
    const logId = await logEmail({
      to: requested, subject, html, template, entity, entityId,
      status: 'queued',
      transport: transportChain()[0] || 'none',
    });

    const row = await require('./outbox').enqueue({
      channel: 'email',
      payload: { to: requested, subject, text, html, template, entity, entityId, logId },
      dedupeKey,
      entity,
      entityId,
    });
    return { ok: true, queued: true, outboxId: row.id, logId, recipients: requested };
  } catch (err) {
    // The queue is a database table, and a database that will not take the
    // row is a worse problem than a slow send. Fall back to sending inline
    // rather than dropping the message, which is what this file exists to stop.
    console.error('Could not queue an email, sending it inline instead:', err.message);
    return sendNow({ to, subject, text, html, template, entity, entityId });
  }
}

/**
 * Send one of the templates in utils/emailMessages.js.
 *
 * `message` is the `{ subject, html, text }` a template returned, so the call
 * site reads as "render this, send it to these people".
 */
async function sendTemplate({ to, message, template, entity, entityId, queue = true, dedupeKey = null }) {
  if (!message || !message.subject) return { ok: false, skipped: 'no message' };
  return sendMail({
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    template,
    entity,
    entityId,
    queue,
    dedupeKey,
  });
}

/** Newest first, for the admin Mail page. */
async function recentLog(limit = 100) {
  const { db } = require('../db/setup');
  return db.recent('email_log', limit);
}

module.exports = {
  redirectTo,
  explainSendError,
  isEnabled,
  transportName,
  transportChain,
  worthAnotherTransport,
  isPermanentFailure,
  NEVER_QUEUED,
  sendNow,
  smtpConfigured,
  smtp2goConfigured,
  smtpSummary,
  verifyTransport,
  sendMail,
  sendTemplate,
  adminRecipients,
  cleanRecipients,
  isAddress,
  fromAddress,
  replyToAddress,
  recentLog,
};
