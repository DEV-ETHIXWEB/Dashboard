'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { db } = require('../db/setup');
const {
  SESSION_COOKIE, createSession, promoteSession, destroySession, safeUser,
  requireAuth, requireRole, requireCSRF, audit, PORTAL_PATH,
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

// Separate, slightly more generous limiter for OTP verification. It shares
// no bucket with loginLimiter: a user re-typing a mistyped code shouldn't
// burn down the same budget that guards the password check, or they could
// get locked out of /login itself despite having the right password.
const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please sign in again in a few minutes.' },
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

// Strips the "::ffff:" prefix Node adds to IPv4 addresses on a dual-stack
// listener, so admins see "127.0.0.1" instead of "::ffff:127.0.0.1".
function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// Constant-time comparison for the 6-digit code, so response timing can't
// be used to narrow down correct digits. Both inputs are normalized to a
// fixed length first since crypto.timingSafeEqual requires equal-length
// buffers (a length mismatch alone is safe to reveal via early return --
// it doesn't leak anything about the code's content).
function codesMatch(submitted, actual) {
  const a = Buffer.from(String(submitted));
  const b = Buffer.from(String(actual));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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

  // Opportunistic cleanup: drop anything past its expiry (regardless of
  // outcome) and retire any still-unconsumed code this same user already
  // had outstanding, so there's only ever one "live" code per user -- an
  // admin can never read out a stale one that verify-otp would reject
  // anyway (it only ever checks the newest).
  await db.pruneExpiredOtps();
  await db.invalidateUserOtps(user.id);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = Date.now() + OTP_TTL_MS;
  await db.insert('otp_codes', {
    userId: user.id,
    code,
    ipAddress: normalizeIp(req.ip),
    createdAt: new Date().toISOString(),
    expiresAt,
    consumed: false,
    attempts: 0,
  });

  res.json({ requiresOtp: true, csrfToken: pendingSession.csrfToken, otpExpiresAt: expiresAt });
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
router.post('/verify-otp', verifyOtpLimiter, async (req, res, next) => {
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

    // Atomically increments attempts only if still below the cap, in one
    // SQL statement. A plain "read attempts, check in JS, write attempts+1"
    // has a real race: concurrent requests can all read the same
    // pre-increment value and all pass the check before any write lands,
    // letting more guesses through than MAX_OTP_ATTEMPTS allows. This
    // returns null (and we lock out) the instant the cap is already hit,
    // whether or not this particular guess would have been correct --
    // matching the original intent that a locked-out code stays locked out.
    const updated = await db.incrementIfBelow('otp_codes', otp.id, 'attempts', MAX_OTP_ATTEMPTS);
    if (!updated) {
      return res.status(403).json({ error: 'Too many incorrect attempts. Please sign in again to get a new code.' });
    }

    if (!codesMatch(code, updated.code)) {
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
// code out to the client requesting it. Codes are NOT included here --
// they're fetched one at a time via POST /otp-logs/:id/reveal, which is
// audit-logged, so there's a real record of which admin looked at which
// code and when, instead of every code being downloaded to the browser
// (and sitting in its memory/devtools) the instant the page loads.
router.get('/otp-logs', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const [otps, users] = await Promise.all([db.recent('otp_codes', 100), db.all('users')]);
    const usersById = new Map(users.map((u) => [u.id, u]));
    const logs = otps.map((o) => {
      const u = usersById.get(o.userId);
      return {
        id: o.id,
        userId: o.userId,
        name: u?.name || 'Unknown user',
        email: u?.email || '—',
        ipAddress: normalizeIp(o.ipAddress),
        createdAt: o.createdAt,
        expiresAt: Number(o.expiresAt),
        consumed: o.consumed,
        attempts: o.attempts,
      };
    });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

router.post('/otp-logs/:id/reveal', requireAuth, requireRole('admin'), requireCSRF, async (req, res, next) => {
  try {
    const otp = await db.find('otp_codes', req.params.id);
    if (!otp) return res.status(404).json({ error: 'Not found' });
    await audit(req.user.id, 'reveal_otp', 'otp_codes', otp.id, { forUserId: otp.userId });
    res.json({ code: otp.code });
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
