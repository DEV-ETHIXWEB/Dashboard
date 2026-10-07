'use strict';

/**
 * The guard on every endpoint a scheduler calls.
 *
 * These endpoints have a caller with no session and no cookie, and they send
 * real messages, so a shared secret is the whole of their authentication. It
 * was written once for the outbox sweep and lives here because the service
 * summary sweep needs exactly the same guard -- and a second copy of a
 * security check is a second thing to forget to fix.
 *
 * Compared with `timingSafeEqual` on equal-length buffers, because a plain
 * `===` on a secret leaks its length and a little of its content to anybody who
 * can time the reply. The same care utils/twilio.js takes over a signature.
 *
 * With no secret configured the endpoint is closed rather than open. An
 * unauthenticated sweep is not harmless: leaving it open on a deployment that
 * forgot to set the variable hands anybody who finds the URL a way to make the
 * app send on command.
 */

const crypto = require('crypto');

/**
 * Whether this request carries the cron secret.
 *
 * `secretNames` is the order the environment is searched in. CRON_SECRET is
 * the name Vercel looks for -- set it, and Vercel's own cron sends
 * `Authorization: Bearer <that value>` with every invocation, which is why it
 * is accepted. A caller-specific name in front of it lets a deployment keep one
 * endpoint's secret separate from whatever else the platform's cron reaches.
 */
function authorisedCron(req, secretNames = ['CRON_SECRET']) {
  const expected = secretNames
    .map((name) => String(process.env[name] || '').trim())
    .find(Boolean);
  if (!expected) return false;

  // Vercel's cron sends a bearer token. The explicit header is for anything
  // else that finds one awkward.
  const header = String(req.get('authorization') || '');
  const provided = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : String(req.get('x-cron-secret') || req.get('x-outbox-secret') || '').trim();
  if (!provided) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { authorisedCron };
