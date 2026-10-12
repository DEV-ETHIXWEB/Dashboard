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
  /**
   * Every configured secret is accepted, not just the first one found.
   *
   * This took the first name that had a value, so setting both
   * OUTBOX_CRON_SECRET and CRON_SECRET meant only the first was valid -- and
   * Vercel's own cron sends CRON_SECRET, so the platform's scheduler got a
   * 401 on every invocation while an operator looked at two correctly-set
   * variables. A caller-specific secret is meant to be *additional* to the
   * platform's, not instead of it.
   */
  const expected = secretNames
    .map((name) => String(process.env[name] || '').trim())
    .filter(Boolean);
  if (expected.length === 0) return false;

  // Vercel's cron sends a bearer token. The explicit header is for anything
  // else that finds one awkward.
  const header = String(req.get('authorization') || '');
  const provided = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : String(req.get('x-cron-secret') || req.get('x-outbox-secret') || '').trim();
  if (!provided) return false;

  const a = Buffer.from(provided, 'utf8');
  // Every candidate is compared, and the comparison is not short-circuited on
  // the first match: `some` would return early and leak which secret matched
  // through timing. The cost is a few microseconds on a scheduler's request.
  let matched = false;
  for (const candidate of expected) {
    const b = Buffer.from(candidate, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

module.exports = { authorisedCron };
