'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/setup');
const { parseAllowedPages } = require('../utils/clientPages');
const live = require('../utils/liveBus');

const SESSION_COOKIE = 'ew_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Clients sign in from a phone, often at a job site, and every expiry is a
// full sign-in round trip they did not ask for. Staff keep the shorter window
// because their accounts can change other people's access.
const CLIENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** How long a signed-in session should last for this account. */
function sessionTtlFor(user) {
  return user?.role === 'client' ? CLIENT_SESSION_TTL_MS : SESSION_TTL_MS;
}

/**
 * Open a session, remembering enough to name it later.
 *
 * `req` is optional so nothing that already called this breaks, but every real
 * sign-in passes it: without the user agent, the session list on a person's own
 * profile can only say "another device" about every row, which is useless for
 * the one thing that list is for -- noticing a session you do not recognise.
 */
/**
 * The database's name for a session, given the secret in the cookie.
 *
 * The cookie value *was* the primary key, so a dump of the sessions table was
 * a list of live credentials: anybody who read it could set one as their own
 * cookie and be signed in as that person, with no password and no second
 * factor in the way. The same reasoning the password and login-link tables
 * already follow -- only the hash is written down -- applied to the one table
 * that grants access directly.
 *
 * SHA-256 without a salt on purpose: this is a 128-bit random value, not a
 * password, so there is nothing to brute-force and the lookup has to be a
 * single indexed read on every request.
 */
function sessionKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

async function createSession(userId, { pending = false, ttlMs = SESSION_TTL_MS, req = null } = {}) {
  const { storableUserAgent } = require('../utils/userAgent');
  // The half that goes in the cookie, and the half that goes in the table.
  const secret = uuidv4();
  const session = {
    id: sessionKey(secret),
    userId,
    csrfToken: uuidv4(),
    createdAt: Date.now(),
    expiresAt: Date.now() + (pending ? 10 * 60 * 1000 : ttlMs), // pending sessions expire in 10 min
    pending,
    userAgent: req ? storableUserAgent(req.get('user-agent')) : null,
    ipAddress: req ? normalizeIp(req.ip) : null,
  };
  await db.insert('sessions', session);
  // `cookie` is the only place the secret exists outside this function. `id`
  // stays the database's key, so everything that compares sessions, revokes
  // them or lists them is unchanged.
  return { ...session, cookie: secret };
}

async function promoteSession(sessionId, { ttlMs = SESSION_TTL_MS } = {}) {
  return db.update('sessions', sessionId, { pending: false, expiresAt: Date.now() + ttlMs });
}

async function getSession(req) {
  const secret = req.cookies?.[SESSION_COOKIE];
  if (!secret) return null;
  const id = sessionKey(secret);
  const session = await db.find('sessions', id);
  if (!session) return null;
  if (Number(session.expiresAt) < Date.now()) {
    await db.remove('sessions', id);
    return null;
  }
  return session;
}

/**
 * Throw away sessions that expired and were never presented again.
 *
 * A session row was only deleted when somebody turned up with its cookie, so
 * every session belonging to a browser that was simply closed stayed in the
 * table for ever -- which on a workspace that signs in daily is a row per
 * person per day, growing without bound, in a table read on every single
 * request.
 *
 * Throttled to once an hour per process and deliberately not awaited by its
 * caller: this is housekeeping, and nobody should wait on it to load a page.
 * Never throws for the same reason.
 */
let lastSessionPrune = 0;

async function pruneExpiredSessions() {
  if (Date.now() - lastSessionPrune < 60 * 60 * 1000) return 0;
  lastSessionPrune = Date.now();
  try {
    const now = Date.now();
    return await db.removeWhere('sessions', (s) => Number(s.expiresAt) < now);
  } catch (err) {
    console.error(`[sessions] could not prune expired sessions: ${err.message}`);
    return 0;
  }
}

async function destroySession(req) {
  const secret = req.cookies?.[SESSION_COOKIE];
  if (secret) await db.remove('sessions', sessionKey(secret));
}

function safeUser(user) {
  if (!user) return null;
  // Derived before the hash is stripped, because "does this account have a
  // password at all" is one of the questions the status answers -- a
  // Google-only account has nothing to rotate. Never exposes the hash itself.
  const passwordStatus = require('../utils/passwordPolicy').statusFor(user);
  const { password, demoPassword, ...rest } = user;
  rest.passwordStatus = passwordStatus;
  rest.hasAvatar = Boolean(user.avatarUpdatedAt);
  // Stored as JSON text on Postgres, as an array on Firestore -- callers always
  // get an array, or null meaning "no page restrictions".
  rest.allowedPages = parseAllowedPages(rest.allowedPages);
  // Postgres hands these back as booleans and Firestore may hand back strings;
  // callers should never have to care which.
  const roles = require('../utils/roles');
  rest.isSuperAdmin = roles.isSuperAdmin(user);
  rest.adminTrusted = roles.isTrustedAdmin(user);
  // Whether this account may be emailed, resolved here so no caller has to
  // know that a null column means yes. See utils/clientMail.js.
  const clientMail = require('../utils/clientMail');
  rest.mailEnabled = clientMail.isMailEnabled(user);
  rest.mailOptOuts = clientMail.parseOptOuts(rest.mailOptOuts);
  return rest;
}

/**
 * The few endpoints that still answer while a password reset is outstanding.
 *
 * Kept as short as it can be and still leave a way out: who am I, sign me out,
 * change my password, and the live stream that tells the tab when the state
 * moved. Anything that reads or writes real work is behind the reset, which is
 * the entire point -- a policy that can be ignored until it is convenient is a
 * suggestion.
 *
 * Matched on the full path with the query string removed, so a caller cannot
 * dress an ordinary endpoint up as an allowed one by appending to it.
 */
const PASSWORD_CHANGE_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/config',
  '/api/events',
  '/api/users/me',
  '/api/users/me/profile',
]);

function isPasswordChangePath(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  return PASSWORD_CHANGE_PATHS.has(path);
}

async function requireAuth(req, res, next) {
  try {
    const session = await getSession(req);
    // Housekeeping on the back of a request that was already touching this
    // table. Throttled inside, and not awaited: see pruneExpiredSessions.
    void pruneExpiredSessions();
    if (!session || session.pending) return res.status(401).json({ error: 'Not signed in' });
    const user = await db.find('users', session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    if (user.passwordExpiresAt && Number(user.passwordExpiresAt) < Date.now()) {
      await db.remove('sessions', session.id);
      return res.status(401).json({ error: 'Your access has expired. Ask your admin to issue you new credentials.', passwordExpired: true });
    }

    req.session = session;
    req.user = user;

    // A password past its month is a different thing from an expired account,
    // and gets a different answer. The account above is finished -- the session
    // is destroyed and there is nothing the holder can do about it. This person
    // is still entitled to be here; they just cannot get on with anything until
    // they have picked a new password. So the session stands and the door to
    // the rest of the app is what closes.
    if (require('../utils/passwordPolicy').isResetRequired(user) && !isPasswordChangePath(req)) {
      return res.status(403).json({
        error: 'Your password has expired. Set a new one to carry on.',
        passwordResetRequired: true,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    next();
  };
}

/** Two secrets, compared without leaking how far they matched. */
function secretsMatch(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireCSRF(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('X-CSRF-Token');
  // Constant-time, like every other secret comparison in this codebase. `!==`
  // stops at the first differing byte, which is a timing signal an attacker
  // can walk a token out of one character at a time.
  if (!req.session || !token || !secretsMatch(token, req.session.csrfToken)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
}

/**
 * An address a person can read.
 *
 * Node reports an IPv4 client on a dual-stack socket as `::ffff:127.0.0.1`.
 * That prefix means nothing to whoever is reading "was this you?" in an email
 * or an audit row, so it comes off. Shared from here because both the auth
 * routes and the profile routes put an address in front of a person, and the
 * two were formatting it differently.
 */
function normalizeIp(ip) {
  if (!ip) return ip;
  return String(ip).startsWith('::ffff:') ? String(ip).slice(7) : ip;
}

async function audit(actorId, action, entity, entityId, meta) {
  await db.insert('activity_log', {
    id: uuidv4(), actorId, action, entity, entityId, meta: meta || null, createdAt: new Date().toISOString(),
  });
}

async function notify(userId, message, type) {
  if (!userId) return;
  // Every role gets notifications: staff need "new ticket" and handover alerts,
  // not just clients.
  const user = await db.find('users', userId);
  if (!user) return;
  await db.insert('notifications', {
    id: uuidv4(), userId, message, type: type || 'general', read: false, createdAt: new Date().toISOString(),
  });
  // Straight to that one person's open tabs. The event says only "you have
  // notifications"; the browser fetches the text through the usual endpoint.
  live.publish('notifications', { to: [userId] });
}

/** Force one account's tabs to re-read who they are -- role or page access moved. */
function refreshSession(userId) {
  if (!userId) return;
  live.publish('session', { to: [userId] });
}

/**
 * Where a sign-in sends somebody, which is the same place for everybody.
 *
 * This was a map from each of the five roles to `/portal.html`, which then
 * redirects to `/portal` -- five keys, one value, and an extra hop. It reads
 * as a routing decision per role and has never been one; the single-page app
 * works out what to show from the session. Kept as one constant so the two
 * call sites still have something to name, and so the redirect goes straight
 * to the real path.
 */
const PORTAL_PATH = '/portal';

module.exports = {
  SESSION_COOKIE,
  createSession, getSession, destroySession, promoteSession, sessionKey, safeUser, sessionTtlFor,
  requireAuth, requireRole, requireCSRF,
  audit, notify, refreshSession, normalizeIp, pruneExpiredSessions, PORTAL_PATH,
};
