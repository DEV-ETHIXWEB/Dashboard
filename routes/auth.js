'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { db } = require('../db/setup');
const {
  SESSION_COOKIE, createSession, promoteSession, destroySession, safeUser,
  requireAuth, requireRole, audit, PORTAL_PATH,
} = require('../middleware/auth');
const { isGoogleSignInConfigured, verifyGoogleIdToken } = require('../utils/googleAuth');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

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

// Every non-admin login requires a second step: an admin-issued OTP. As
// soon as the password check succeeds we generate a 6-digit code and log
// it (with the requester's name/email/IP) for an admin to read out to the
// client over another channel -- there is no automatic SMS/email delivery.
// Admins themselves skip this step: they're the only ones who can see the
// OTP panel, so gating their own login behind it would lock them out.
async function finishLogin(req, res, user) {
  if (user.role === 'admin') {
    const session = await createSession(user.id);
    res.cookie(SESSION_COOKIE, session.id, COOKIE_OPTS);
    await audit(user.id, 'login', 'user', user.id);
    return res.json({ user: safeUser(user), csrfToken: session.csrfToken, redirect: PORTAL_PATH[user.role] || '/portal.html' });
  }

  const pendingSession = await createSession(user.id, { pending: true });
  res.cookie(SESSION_COOKIE, pendingSession.id, COOKIE_OPTS);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.insert('otp_codes', {
    userId: user.id,
    code,
    ipAddress: req.ip,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + OTP_TTL_MS,
    consumed: false,
    attempts: 0,
  });

  res.json({ requiresOtp: true, csrfToken: pendingSession.csrfToken });
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

// Step 2 of login: the client submits the 6-digit code an admin read out
// to them from the /otp-logs panel.
router.post('/verify-otp', loginLimiter, async (req, res, next) => {
  try {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) return res.status(401).json({ error: 'No pending login found. Please sign in again.' });
    const session = await db.find('sessions', sid);
    if (!session || !session.pending || Number(session.expiresAt) < Date.now()) {
      return res.status(401).json({ error: 'Your verification step expired. Please sign in again.' });
    }

    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });

    const user = await db.find('users', session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });

    const otps = await db.filter('otp_codes', (o) => o.userId === user.id && !o.consumed);
    const otp = otps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (!otp || Number(otp.expiresAt) < Date.now()) {
      return res.status(403).json({ error: 'That code has expired. Please sign in again to get a new one.' });
    }
    if (otp.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(403).json({ error: 'Too many incorrect attempts. Please sign in again to get a new code.' });
    }
    if (String(code) !== otp.code) {
      await db.update('otp_codes', otp.id, { attempts: otp.attempts + 1 });
      return res.status(403).json({ error: 'Incorrect code.' });
    }

    await db.update('otp_codes', otp.id, { consumed: true });
    const promoted = await promoteSession(session.id);
    await audit(user.id, 'login', 'user', user.id, { via: 'otp' });
    res.json({ user: safeUser(user), csrfToken: promoted.csrfToken, redirect: PORTAL_PATH[user.role] || '/portal.html' });
  } catch (err) {
    next(err);
  }
});

// Admin-only feed of recently generated login OTPs, so an admin can read a
// code out to the client requesting it. Codes are returned in full -- the
// frontend keeps them masked until the admin clicks to reveal.
router.get('/otp-logs', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const [otps, users] = await Promise.all([db.all('otp_codes'), db.all('users')]);
    const usersById = new Map(users.map((u) => [u.id, u]));
    const logs = otps
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 100)
      .map((o) => {
        const u = usersById.get(o.userId);
        return {
          id: o.id,
          userId: o.userId,
          name: u?.name || 'Unknown user',
          email: u?.email || '—',
          ipAddress: o.ipAddress,
          code: o.code,
          createdAt: o.createdAt,
          expiresAt: Number(o.expiresAt),
          consumed: o.consumed,
        };
      });
    res.json({ logs });
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
