'use strict';

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

async function createSession(userId, { pending = false, ttlMs = SESSION_TTL_MS } = {}) {
  const session = {
    id: uuidv4(),
    userId,
    csrfToken: uuidv4(),
    createdAt: Date.now(),
    expiresAt: Date.now() + (pending ? 10 * 60 * 1000 : ttlMs), // pending sessions expire in 10 min
    pending,
  };
  await db.insert('sessions', session);
  return session;
}

async function promoteSession(sessionId, { ttlMs = SESSION_TTL_MS } = {}) {
  return db.update('sessions', sessionId, { pending: false, expiresAt: Date.now() + ttlMs });
}

async function getSession(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const session = await db.find('sessions', sid);
  if (!session) return null;
  if (Number(session.expiresAt) < Date.now()) {
    await db.remove('sessions', sid);
    return null;
  }
  return session;
}

async function destroySession(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) await db.remove('sessions', sid);
}

function safeUser(user) {
  if (!user) return null;
  const { password, demoPassword, ...rest } = user;
  // Stored as JSON text on Postgres, as an array on Firestore -- callers always
  // get an array, or null meaning "no page restrictions".
  rest.allowedPages = parseAllowedPages(rest.allowedPages);
  return rest;
}

async function requireAuth(req, res, next) {
  try {
    const session = await getSession(req);
    if (!session || session.pending) return res.status(401).json({ error: 'Not signed in' });
    const user = await db.find('users', session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    if (user.passwordExpiresAt && Number(user.passwordExpiresAt) < Date.now()) {
      await db.remove('sessions', session.id);
      return res.status(401).json({ error: 'Your access has expired. Ask your admin to issue you new credentials.', passwordExpired: true });
    }

    req.session = session;
    req.user = user;
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

function requireCSRF(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('X-CSRF-Token');
  if (!req.session || !token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
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

const PORTAL_PATH = {
  admin: '/portal.html',
  sales: '/portal.html',
  project_manager: '/portal.html',
  employee: '/portal.html',
  client: '/portal.html',
};

module.exports = {
  SESSION_COOKIE,
  createSession, getSession, destroySession, promoteSession, safeUser, sessionTtlFor,
  requireAuth, requireRole, requireCSRF,
  audit, notify, refreshSession, PORTAL_PATH,
};
