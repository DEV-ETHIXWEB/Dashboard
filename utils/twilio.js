'use strict';

/**
 * Twilio, reduced to the three things this app actually needs: prove a webhook
 * really came from Twilio, put a phone number into a shape we can match on, and
 * send a text back out.
 *
 * No SDK. The REST call is one form-encoded POST and the signature check is
 * thirty lines of crypto, so pulling in a client library would be more surface
 * area than the feature has.
 */

const crypto = require('crypto');

const API_BASE = 'https://api.twilio.com/2010-04-01';

function accountSid() {
  return process.env.TWILIO_ACCOUNT_SID || '';
}

function authToken() {
  return process.env.TWILIO_AUTH_TOKEN || '';
}

function fromNumber() {
  return process.env.TWILIO_NUMBER || '';
}

/** Whether inbound webhooks can be verified at all. */
function isEnabled() {
  return Boolean(accountSid() && authToken());
}

/**
 * Whether this deployment may send messages out.
 *
 * Off by default, and deliberately so. A US long code cannot carry A2P traffic
 * until its 10DLC campaign is registered and approved; sending before that
 * earns error 30034 per attempt and counts against the number's reputation
 * score. Inbound has no such gate, so the inbox works from day one and this
 * switch is flipped on the day registration clears.
 */
function outboundEnabled() {
  return String(process.env.SMS_OUTBOUND_ENABLED || 'off').toLowerCase() === 'on';
}

// --- signature verification ------------------------------------------------

/**
 * The URL Twilio signed.
 *
 * Twilio computes its signature over the exact URL it requested, so this has to
 * reproduce that string character for character. Behind a reverse proxy --
 * which is every real deployment, Cloudways included -- the app sees the
 * *inside* of the hop: an http:// scheme, and sometimes an internal host.
 * Derive the URL from the request and the signature will not match, and every
 * message is rejected with a 403 that looks exactly like an attack.
 *
 * So TWILIO_WEBHOOK_URL is authoritative when set, and it is the supported way
 * to run this. The derived value below is a development convenience only.
 */
function signedUrl(req) {
  const configured = process.env.TWILIO_WEBHOOK_URL;
  if (configured) return configured.trim();

  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return `${proto}://${host}${req.originalUrl || req.url || ''}`;
}

/**
 * Twilio's scheme: take the full URL, append every POST field as key then value
 * in alphabetical order by key, HMAC-SHA1 it with the auth token, base64 it.
 */
function expectedSignature(url, params) {
  let payload = url;
  for (const key of Object.keys(params || {}).sort()) {
    const value = params[key];
    payload += key + (value == null ? '' : String(value));
  }
  return crypto.createHmac('sha1', authToken()).update(Buffer.from(payload, 'utf8')).digest('base64');
}

/**
 * Whether this request really came from Twilio.
 *
 * A failure here means the body is not to be trusted at all, so callers must
 * read nothing out of it -- the same rule the Stripe webhook already follows in
 * routes/billing.js.
 */
function verifySignature(req) {
  if (!isEnabled()) return false;

  const provided = req.get('x-twilio-signature');
  if (!provided) return false;

  const expected = expectedSignature(signedUrl(req), req.body);

  // timingSafeEqual throws on a length mismatch rather than returning false,
  // and a wrong-length signature is exactly what a probe sends.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- phone numbers ---------------------------------------------------------

/**
 * A number in the shape we store: E.164, or null when it cannot be read as one.
 *
 * Twilio always hands us E.164 already. This exists for the other direction --
 * an admin typing a client's number into the people page, where "(206) 895
 * 6963" and "+1 206-895-6963" are the same phone and both should work.
 */
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;

  if (trimmed.startsWith('+')) return `+${digits}`;
  // A bare 10-digit number is a North American one typed without its country
  // code, which is how people write their own number. Anything longer is
  // assumed to already carry one.
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/**
 * The loose key two numbers are compared on: the last ten digits.
 *
 * Exact E.164 equality is the right rule and the caller tries it first. This is
 * the fallback for numbers a human typed, where a missing or wrong country code
 * is common. Ten digits is long enough that a collision inside one workspace's
 * client list is not a practical concern, and the only consequence of one would
 * be a message shown against the wrong client name in a staff-only inbox --
 * visible, and fixable in one click.
 */
function phoneKey(raw) {
  const normalized = normalizePhone(raw);
  if (!normalized) return null;
  const digits = normalized.replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// --- sending ---------------------------------------------------------------

/**
 * Send one SMS. Never throws: an outbound failure must not take down whatever
 * was being done at the time, and the inbox is the record that matters.
 *
 * Returns the message SID on success, and null when sending is switched off,
 * unconfigured, or refused.
 */
async function sendSms({ to, body }) {
  if (!outboundEnabled()) return null;
  if (!isEnabled() || !fromNumber()) return null;
  if (!to || !body || !body.trim()) return null;

  const form = new URLSearchParams({ To: to, From: fromNumber(), Body: body.trim().slice(0, 1600) });
  const auth = Buffer.from(`${accountSid()}:${authToken()}`).toString('base64');

  try {
    const res = await fetch(`${API_BASE}/Accounts/${accountSid()}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // 30034 is the one worth naming: the number is carrying A2P traffic
      // before its 10DLC campaign was approved, which is a registration problem
      // and not something a retry will ever fix.
      const code = data.code ? ` (code ${data.code})` : '';
      const hint = data.code === 30034
        ? ' The number is not registered for A2P 10DLC yet, so Twilio will refuse every send until that clears.'
        : '';
      console.error(`Twilio refused an outbound message${code}: ${data.message || res.status}.${hint}`);
      return null;
    }
    return data.sid || null;
  } catch (err) {
    console.error('Could not reach Twilio to send a message:', err.message);
    return null;
  }
}

module.exports = {
  isEnabled,
  outboundEnabled,
  fromNumber,
  signedUrl,
  verifySignature,
  normalizePhone,
  phoneKey,
  sendSms,
};
