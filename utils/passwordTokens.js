'use strict';

/**
 * Links that let somebody set a password without ever being sent one.
 *
 * The shape is lifted wholesale from utils/loginLinks.js, because that file
 * already answers the same questions correctly and two different token formats
 * in one codebase is two things to get wrong. A token is `<id>.<secret>`: the
 * id names the row, the secret is 32 random bytes, and only the SHA-256 of the
 * secret is ever written down. A database leak therefore yields nothing
 * replayable -- which is the entire reason the app does not email passwords on
 * this path.
 *
 * Two purposes share the table because they share every property that matters:
 *
 *   activation  a new account choosing its first password
 *   reset       an existing account replacing an expired or forgotten one
 *
 * The difference is only how long they live and which email carries them.
 *
 * Where the token travels is deliberate too. The emailed URL puts it in the
 * **fragment** (`#token=...`), which no browser sends to a server: it stays out
 * of access logs, out of `Referer` headers on any onward click, and out of
 * proxy records. The page reads it in JavaScript and posts it in a request
 * body. A link-preview scanner that follows the URL also cannot burn the
 * single use, because the fragment never reaches us.
 */

const crypto = require('crypto');

const SECRET_BYTES = 32;

const PURPOSES = ['activation', 'reset'];

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/** Fresh id + secret. The secret exists in memory and in one email, nowhere else. */
function issueToken() {
  return { id: crypto.randomUUID(), secret: crypto.randomBytes(SECRET_BYTES).toString('base64url') };
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
 * Mint a link for one account and store its hash.
 *
 * Any earlier unused token for the same account and purpose is dropped, so a
 * second "send me a link" quietly retires the first rather than leaving two
 * live doors. Returns the path to open and when it stops working; the caller
 * builds the absolute URL, the way routes/auth.js does for sign-in links.
 *
 * The database is required lazily, as utils/mailer.js does, so the pure token
 * helpers above stay usable without a connection.
 */
async function issueFor(user, { purpose = 'reset', ttlMs, ipAddress = null, issuedBy = null } = {}) {
  if (!PURPOSES.includes(purpose)) throw new TypeError(`Unknown password token purpose: ${purpose}`);
  const { db } = require('../db/setup');
  const policy = require('./passwordPolicy');

  await db.pruneExpiredPasswordTokens();
  await db.invalidateUserPasswordTokens(user.id, purpose);

  const cfg = policy.config();
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : (purpose === 'activation' ? cfg.activationTtlMs : cfg.resetTtlMs);

  const token = issueToken();
  const expiresAt = Date.now() + lifetime;

  await db.insert('password_tokens', {
    id: token.id,
    userId: user.id,
    purpose,
    tokenHash: hashSecret(token.secret),
    ipAddress,
    createdAt: new Date().toISOString(),
    expiresAt,
    consumed: false,
    issuedBy,
  });

  return {
    path: `/set-password#token=${encodeURIComponent(formatToken(token))}`,
    expiresAt,
    ttlMs: lifetime,
    purpose,
  };
}

/**
 * Look a token up and say whether it is usable, without spending it.
 *
 * Used by the page that opens the link, so someone with a dead link is told
 * why before they type a password into a form that cannot work. The reasons
 * are deliberately coarse -- `invalid` covers "no such row" and "wrong secret"
 * alike, so guessing at ids learns nothing.
 */
async function inspect(raw) {
  const { db } = require('../db/setup');
  const parsed = parseToken(raw);
  if (!parsed) return { ok: false, reason: 'invalid' };

  const row = await db.find('password_tokens', parsed.id);
  if (!row) return { ok: false, reason: 'invalid' };
  if (!secretMatches(parsed.secret, row.tokenHash)) return { ok: false, reason: 'invalid' };
  if (row.consumed) return { ok: false, reason: 'used' };
  if (Number(row.expiresAt) < Date.now()) return { ok: false, reason: 'expired' };

  const user = await db.find('users', row.userId);
  if (!user) return { ok: false, reason: 'invalid' };

  return { ok: true, row, user };
}

/**
 * Spend a token, once.
 *
 * `inspect` proves the secret; this claims the row. The claim is a conditional
 * update in the driver (see consumePasswordToken), so two submissions arriving
 * together means exactly one of them gets a row back and the other is told the
 * link has already been used.
 */
async function consume(raw) {
  const { db } = require('../db/setup');
  const checked = await inspect(raw);
  if (!checked.ok) return checked;

  const claimed = await db.consumePasswordToken(checked.row.id);
  if (!claimed) return { ok: false, reason: 'used' };
  return { ok: true, row: claimed, user: checked.user };
}

/** Every unused link for this account stops working. */
async function revokeAllFor(userId) {
  const { db } = require('../db/setup');
  await db.invalidateUserPasswordTokens(userId);
}

module.exports = {
  PURPOSES,
  SECRET_BYTES,
  issueToken,
  issueFor,
  hashSecret,
  formatToken,
  parseToken,
  secretMatches,
  inspect,
  consume,
  revokeAllFor,
};
