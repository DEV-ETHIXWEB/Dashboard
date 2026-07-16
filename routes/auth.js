'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { db } = require('../db/setup');
const {
  SESSION_COOKIE, createSession, promoteSession, destroySession, safeUser,
  requireAuth, audit, PORTAL_PATH,
} = require('../middleware/auth');
const { isGoogleSignInConfigured, verifyGoogleIdToken } = require('../utils/googleAuth');
const { isFirebaseAdminConfigured, verifyFirebaseIdToken } = require('../utils/firebaseAdmin');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

async function finishLogin(req, res, user) {
  if (user.twoFactorEnabled) {
    const pendingSession = await createSession(user.id, { pending: true });
    res.cookie(SESSION_COOKIE, pendingSession.id, COOKIE_OPTS);
    return res.json({
      requires2FA: true,
      twoFactorContact: maskContact(user.twoFactorContact),
      csrfToken: pendingSession.csrfToken,
    });
  }
  const session = await createSession(user.id);
  res.cookie(SESSION_COOKIE, session.id, COOKIE_OPTS);
  await audit(user.id, 'login', 'user', user.id);
  res.json({ user: safeUser(user), csrfToken: session.csrfToken, redirect: PORTAL_PATH[user.role] || '/portal.html' });
}

function maskContact(contact) {
  if (!contact) return null;
  if (contact.includes('@')) {
    const [name, domain] = contact.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `***${contact.slice(-4)}`;
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const users = await db.filter('users', (u) => u.email.toLowerCase() === String(email).toLowerCase());
    const user = users[0];
    if (!user || !user.password || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await finishLogin(req, res, user);
  } catch (err) {
    next(err);
  }
});

// Sign in with Google -- only works for an email that already has an
// account here (an admin must have added them first). Prevents random
// Google accounts from self-registering into the CRM.
router.post('/google', loginLimiter, async (req, res, next) => {
  try {
    if (!isGoogleSignInConfigured()) {
      return res.status(503).json({ error: 'Sign in with Google is not configured yet.' });
    }
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    const { googleId, email } = await verifyGoogleIdToken(idToken);
    const users = await db.filter('users', (u) => u.email.toLowerCase() === email.toLowerCase());
    const user = users[0];
    if (!user) {
      return res.status(403).json({ error: `No account found for ${email}. Ask your admin to add you first.` });
    }
    if (!user.googleId) await db.update('users', user.id, { googleId });
    await finishLogin(req, res, user);
  } catch (err) {
    next(err);
  }
});

// Step 2 of login when the account has 2FA enabled. The client verifies a
// phone or email code via the Firebase client SDK, then sends us the
// resulting Firebase ID token to confirm here.
router.post('/verify-2fa', loginLimiter, async (req, res, next) => {
  try {
    const sid = req.cookies?.[require('../middleware/auth').SESSION_COOKIE];
    if (!sid) return res.status(401).json({ error: 'No pending login found. Please sign in again.' });
    const session = await db.find('sessions', sid);
    if (!session || !session.pending || Number(session.expiresAt) < Date.now()) {
      return res.status(401).json({ error: 'Your verification step expired. Please sign in again.' });
    }

    if (!isFirebaseAdminConfigured()) {
      return res.status(503).json({ error: '2FA verification is not configured on the server yet.' });
    }
    const { firebaseIdToken } = req.body || {};
    if (!firebaseIdToken) return res.status(400).json({ error: 'firebaseIdToken is required' });

    const user = await db.find('users', session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    const decoded = await verifyFirebaseIdToken(firebaseIdToken);
    const verifiedContact = decoded.phone_number || decoded.email;
    if (!verifiedContact || verifiedContact.toLowerCase() !== String(user.twoFactorContact || '').toLowerCase()) {
      return res.status(403).json({ error: 'That verification does not match the contact on file for this account.' });
    }

    const promoted = await promoteSession(session.id);
    await audit(user.id, 'login', 'user', user.id, { via: '2fa' });
    res.json({ user: safeUser(user), csrfToken: promoted.csrfToken, redirect: PORTAL_PATH[user.role] || '/portal.html' });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await audit(req.user.id, 'logout', 'user', req.user.id);
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: safeUser(req.user), csrfToken: req.session.csrfToken });
});

module.exports = router;
