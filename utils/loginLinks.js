'use strict';

/**
 * One-tap sign-in links.
 *
 * A link carries `<id>.<secret>`: the id names the row, the secret is 32 random
 * bytes. Only the SHA-256 of the secret is stored, so the database never holds
 * anything replayable -- unlike the OTP codes, which have to be decryptable
 * because an admin may need to read one out loud.
 *
 * The link is a bearer credential. That is the point: possession of the inbox
 * is the factor, in place of a typed password plus a typed code. Kept short
 * (15 minutes) and single-use to bound the exposure.
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 15 * 60 * 1000;
/**
 * A welcome email is often opened hours after it lands, so the link inside it
 * gets a longer window than one an admin copies and sends while the client is
 * waiting. Still single-use.
 */
const WELCOME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;

/** Fresh id + secret + the hash to store. The secret is never persisted. */
function issueToken() {
  return {
    id: crypto.randomUUID(),
    secret: crypto.randomBytes(SECRET_BYTES).toString('base64url'),
  };
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/** The value that goes in the emailed URL. */
function formatToken({ id, secret }) {
  return `${id}.${secret}`;
}

/** Split an incoming token back into its two halves, or null if malformed. */
function parseToken(raw) {
  if (typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

/** Constant-time compare of a submitted secret against a stored hash. */
function secretMatches(secret, storedHash) {
  if (typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Mint a link for one client and store it, returning the path to open.
 *
 * A path, not an absolute URL: the caller knows which origin the person is
 * actually on (see the note in routes/auth.js). Any earlier unused link for
 * the same client is dropped, so only the newest one ever works.
 *
 * The database is required lazily, the way utils/mailer.js does it, so the
 * pure token helpers above stay usable without a connection.
 */
async function issueFor(user, { ipAddress = null, ttlMs = TOKEN_TTL_MS } = {}) {
  const { db } = require('../db/setup');

  await db.pruneExpiredLoginLinks();
  await db.invalidateUserLoginLinks(user.id);

  const token = issueToken();
  const expiresAt = Date.now() + ttlMs;
  await db.insert('login_links', {
    id: token.id,
    userId: user.id,
    tokenHash: hashSecret(token.secret),
    ipAddress,
    createdAt: new Date().toISOString(),
    expiresAt,
    consumed: false,
  });

  return { path: `/api/auth/magic-link/verify?token=${encodeURIComponent(formatToken(token))}`, expiresAt };
}

module.exports = {
  TOKEN_TTL_MS,
  WELCOME_TOKEN_TTL_MS,
  issueToken,
  issueFor,
  hashSecret,
  formatToken,
  parseToken,
  secretMatches,
};
