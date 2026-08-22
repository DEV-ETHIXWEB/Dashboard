'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const live = require('../utils/liveBus');
const router = express.Router();

const { db } = require('../db/setup');
const {
  SESSION_COOKIE, createSession, promoteSession, destroySession, safeUser,
  requireAuth, requireRole, requireCSRF, audit, PORTAL_PATH, sessionTtlFor,
} = require('../middleware/auth');
const { isGoogleSignInConfigured, verifyGoogleIdToken } = require('../utils/googleAuth');
const { encryptCode, decryptCode, codesMatch } = require('../utils/otpCrypto');
const loginLinks = require('../utils/loginLinks');
const { baseUrl } = require('../utils/appUrl');
const mailer = require('../utils/mailer');
const messages = require('../utils/emailMessages');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

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

function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

async function finishLogin(req, res, user) {
  if (user.passwordExpiresAt && Number(user.passwordExpiresAt) < Date.now()) {
    return res.status(403).json({ error: 'This access has expired. Ask your admin to issue you new credentials.', passwordExpired: true });
  }

  if (user.role === 'admin') {
    const session = await createSession(user.id);
    res.cookie(SESSION_COOKIE, session.id, COOKIE_OPTS);
    await audit(user.id, 'login', 'user', user.id);
    return res.json({ user: safeUser(user), csrfToken: session.csrfToken, redirect: PORTAL_PATH[user.role] || '/portal.html' });
  }

  const pendingSession = await createSession(user.id, { pending: true });
  res.cookie(SESSION_COOKIE, pendingSession.id, COOKIE_OPTS);

  await db.pruneExpiredOtps();
  await db.invalidateUserOtps(user.id);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = Date.now() + OTP_TTL_MS;
  await db.insert('otp_codes', {
    userId: user.id,
    code: encryptCode(code),
    ipAddress: normalizeIp(req.ip),
    createdAt: new Date().toISOString(),
    expiresAt,
    consumed: false,
    attempts: 0,
  });

  // After the insert, never before: an admin's tab refetches the moment this
  // fires, and a code announced before it exists is a refetch that finds
  // nothing and then sits there looking broken.
  live.publish('otp');

  // Email the code so signing in does not depend on an admin reading it out of
  // the Login Codes page. That page stays as the fallback for a workspace with
  // no mail transport configured yet.
  let codeEmailed = false;
  try {
    const result = await mailer.sendTemplate({
      to: user.email,
      message: messages.loginCode({ user, code, expiresAt, ipAddress: normalizeIp(req.ip) }),
      template: 'login_code',
      entity: 'user',
      entityId: user.id,
    });
    codeEmailed = Boolean(result.ok);
  } catch (err) {
    console.error('Could not email the sign-in code:', err.message);
  }

  res.json({
    requiresOtp: true,
    csrfToken: pendingSession.csrfToken,
    otpExpiresAt: expiresAt,
    codeEmailed,
    codeDestination: codeEmailed ? maskEmail(user.email) : null,
  });
}

/** "da***@example.com" -- enough to recognise the inbox, not enough to harvest it. */
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return null;
  const head = name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
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

/**
 * Mint a one-tap sign-in link for a client, for an admin to hand over.
 *
 * Admin-only and deliberately not self-service: a link is a bearer credential,
 * so whoever holds it is signed in as that client. An admin decides who gets
 * one and over which channel. Only client accounts are eligible -- staff and
 * admin accounts can change other people's access, and a pasteable URL is not
 * a strong enough gate for that.
 *
 * The response carries a `path`, not just an absolute URL, so the admin portal
 * can build the link against the origin it is actually being served from. In
 * development that is the Vite origin (localhost:5173), while the backend only
 * ever sees the proxy's own host -- an absolute URL built server-side would
 * point at the wrong place.
 */
router.post('/login-link/:userId', requireAuth, requireRole('admin'), requireCSRF, async (req, res, next) => {
  try {
    const user = await db.find('users', req.params.userId);
    if (!user) return res.status(404).json({ error: 'No such user' });
    if (user.role !== 'client') {
      return res.status(400).json({ error: 'Sign-in links are for client accounts only.' });
    }
    if (user.passwordExpiresAt && Number(user.passwordExpiresAt) < Date.now()) {
      return res.status(409).json({ error: `${user.name}'s access has expired. Set a new expiry date first.` });
    }

    // An admin can say how long the link should live. The value is clamped
    // rather than trusted: this is a bearer credential, and "expires in a year"
    // is not a choice worth offering however it is asked for.
    const ttlMs = loginLinks.resolveTtl(req.body?.expiresInMinutes);

    const { path, expiresAt } = await loginLinks.issueFor(user, {
      ipAddress: normalizeIp(req.ip),
      ttlMs,
    });
    await audit(req.user.id, 'issue_login_link', 'user', user.id, { expiresAt, ttlMs });
    res.json({
      path,
      url: baseUrl() ? `${baseUrl()}${path}` : null,
      expiresAt,
      expiresInMinutes: Math.round(ttlMs / 60000),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Open a sign-in link. This is a top-level navigation from an inbox, so it
 * answers with a redirect rather than JSON, and failures land back on the
 * login page with a reason the UI can explain.
 */
router.get('/magic-link/verify', async (req, res, next) => {
  const fail = (reason) => res.redirect(`/login?linkError=${reason}`);
  try {
    const parsed = loginLinks.parseToken(req.query.token);
    if (!parsed) return fail('invalid');

    const row = await db.find('login_links', parsed.id);
    if (!row) return fail('invalid');
    if (row.consumed) return fail('used');
    if (Number(row.expiresAt) < Date.now()) return fail('expired');
    if (!loginLinks.secretMatches(parsed.secret, row.tokenHash)) return fail('invalid');

    const user = await db.find('users', row.userId);
    if (!user || user.role !== 'client') return fail('invalid');
    if (user.passwordExpiresAt && Number(user.passwordExpiresAt) < Date.now()) return fail('access_expired');

    // Claim the link before minting the session: two clicks racing each other
    // means exactly one of them gets a row back here.
    const claimed = await db.consumeLoginLink(row.id);
    if (!claimed) return fail('used');

    const ttlMs = sessionTtlFor(user);
    const session = await createSession(user.id, { ttlMs });
    res.cookie(SESSION_COOKIE, session.id, { ...COOKIE_OPTS, maxAge: ttlMs });
    await audit(user.id, 'login', 'user', user.id, { via: 'magic_link' });
    res.redirect('/portal');
  } catch (err) {
    next(err);
  }
});

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

    const updated = await db.incrementIfBelow('otp_codes', otp.id, 'attempts', MAX_OTP_ATTEMPTS);
    if (!updated) {
      return res.status(403).json({ error: 'Too many incorrect attempts. Please sign in again to get a new code.' });
    }

    if (!codesMatch(code, updated.code)) {
      return res.status(403).json({ error: 'Incorrect code.' });
    }

    await db.update('otp_codes', otp.id, { consumed: true });
    const ttlMs = sessionTtlFor(user);
    const promoted = await promoteSession(session.id, { ttlMs });
    // The pending cookie was written with the default window; re-issue it so the
    // browser keeps the session for as long as the server will honour it.
    res.cookie(SESSION_COOKIE, session.id, { ...COOKIE_OPTS, maxAge: ttlMs });
    await audit(user.id, 'login', 'user', user.id, { via: 'otp' });
    res.json({ user: safeUser(user), csrfToken: promoted.csrfToken, redirect: PORTAL_PATH[user.role] || '/portal.html' });
  } catch (err) {
    next(err);
  }
});

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
        email: u?.email || '-',
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
    const code = decryptCode(otp.code);
    if (code === null) {
      return res.status(409).json({
        error: 'This code can no longer be read, most likely because the server restarted. Ask the client to sign in again for a fresh code.',
      });
    }
    await audit(req.user.id, 'reveal_otp', 'otp_codes', otp.id, { forUserId: otp.userId });
    res.json({ code });
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
  // Capabilities travel with the session so the UI never has to re-derive the
  // rules. The server checks them again on every route regardless.
  res.json({
    user: safeUser(req.user),
    capabilities: require('../utils/roles').capabilitiesFor(req.user),
    csrfToken: req.session.csrfToken,
  });
});

module.exports = router;
