'use strict';

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/setup');

const SESSION_COOKIE = 'ew_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(userId) {
  const session = {
    id: uuidv4(),
    userId,
    csrfToken: uuidv4(),
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  db.insert('sessions', session);
  return session;
}

function getSession(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const session = db.find('sessions', sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    db.remove('sessions', sid);
    return null;
  }
  return session;
}

function destroySession(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) db.remove('sessions', sid);
}

function safeUser(user) {
  if (!user) return null;
  const { password, demoPassword, ...rest } = user;
  return rest;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  const user = db.find('users', session.userId);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.session = session;
  req.user = user;
  next();
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

function audit(actorId, action, entity, entityId, meta) {
  db.insert('activity_log', {
    id: uuidv4(), actorId, action, entity, entityId, meta: meta || null, createdAt: new Date().toISOString(),
  });
}

function notify(userId, message, type) {
  if (!userId) return;
  db.insert('notifications', {
    id: uuidv4(), userId, message, type: type || 'general', read: false, createdAt: new Date().toISOString(),
  });
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
  createSession, getSession, destroySession, safeUser,
  requireAuth, requireRole, requireCSRF,
  audit, notify, PORTAL_PATH,
};
