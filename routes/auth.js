'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const live = require('../utils/liveBus');
const router = express.Router();

const { db } = require('../db/setup');
const {
  SESSION_COOKIE, createSession, destroySession, safeUser,
  requireAuth, requireRole, requireCSRF, audit, notify, PORTAL_PATH, sessionTtlFor,
} = require('../middleware/auth');
const roles = require('../utils/roles');
const { sensitiveAdminLimiter } = require('../utils/rateLimits');
const recoveryCodes = require('../utils/recoveryCodes');
const admins = require('../utils/admins');
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

  // Every role finishes sign-in the same way: a password (or a Google
  // assertion) opens a *pending* session, and only the emailed code turns it
  // into a real one. Administrators used to skip this, which meant the accounts
  // that can reset everyone else's password were the ones protected by a single
  // factor. It also made the reply shape a role oracle -- an admin got a
  // session, everybody else got "we emailed you a code" -- so anyone testing
  // passwords could pick out the accounts with no second step. One path now,
  // one reply shape.
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
router.post(
  '/login-link/:userId',
  requireAuth,
  requireRole('admin'),
  requireCSRF,
  sensitiveAdminLimiter,
  async (req, res, next) => {
  try {
    // Whoever holds the link is the client, and nothing stops the admin who
    // minted it from opening it themselves. That is not a power a brand-new
    // account gets: it needs an admin the workspace has vouched for.
    if (!roles.isTrustedAdmin(req.user)) {
      return res.status(403).json({
        error: 'Issuing a sign-in link needs a trusted admin. Ask a colleague who has been vouched for.',
      });
    }

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
    // The one thing the "two-step sign in" switch actually controls. A sign-in
    // link is a bearer credential -- possession of the inbox replaces both the
    // password and the code -- so an account that has asked for a second factor
    // must not have one minted for it. Before this, the switch wrote a value
    // that no part of the login path ever read.
    if (roles.flag(user.twoFactorEnabled)) {
      return res.status(409).json({
        error: `${user.name} has two-step sign in switched on, so a one-tap link would step around it. They sign in with their password and a code.`,
      });
    }

    const ttlMs = loginLinks.resolveTtl(req.body?.expiresInMinutes);

    const { path, expiresAt } = await loginLinks.issueFor(user, {
      ipAddress: normalizeIp(req.ip),
      ttlMs,
    });
    await audit(req.user.id, 'issue_login_link', 'user', user.id, {
      expiresAt,
      ttlMs,
      issuedBy: req.user.id,
      issuedByName: req.user.name,
    });
    // The client is told, in their own portal, that a link now exists for their
    // account. A link that can be used silently and shows up in the record as
    // the client's own activity is an impersonation tool; one the client can
    // see being issued is a support feature.
    await notify(
      user.id,
      `${req.user.name} created a one-tap sign-in link for your account. If you did not ask for one, tell us.`,
      'security',
    );
    res.json({
      path,
      url: baseUrl() ? `${baseUrl()}${path}` : null,
      expiresAt,
      expiresInMinutes: Math.round(ttlMs / 60000),
    });
  } catch (err) {
    next(err);
  }
},
);

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
    // Checked again at the moment of use, not only when the link was minted:
    // the switch may have been turned on since, and an old link in an inbox
    // must not outlive the decision.
    if (roles.flag(user.twoFactorEnabled)) return fail('two_factor');

    // Claim the link before minting the session: two clicks racing each other
    // means exactly one of them gets a row back here.
    const claimed = await db.consumeLoginLink(row.id);
    if (!claimed) return fail('used');

    const ttlMs = sessionTtlFor(user);
    const session = await createSession(user.id, { ttlMs });
    res.cookie(SESSION_COOKIE, session.id, { ...COOKIE_OPTS, maxAge: ttlMs });
    // Name the admin who minted the link. Without it the log shows the client
    // signing themselves in, which is exactly what an admin walking in through
    // a link they made would want it to say.
    const issued = (await db.filter('activity_log', (a) => a.action === 'issue_login_link' && a.entityId === user.id))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    await audit(user.id, 'login', 'user', user.id, {
      via: 'magic_link',
      linkIssuedBy: issued?.actorId || null,
    });
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

    // A backup code stands in for the emailed one, for administrators only.
    // Everyone else has an admin who can read their code off the Login Codes
    // page; an admin has nobody, which is the whole reason these exist.
    //
    // Note where this sits: *after* the pending session has been proved, so the
    // password step still happened. This replaces the second factor, it does
    // not skip it. Checked before the emailed code is even looked up, so a
    // recovery attempt never spends one of the five tries on the emailed one.
    if (roles.isAdmin(user) && recoveryCodes.looksLikeRecoveryCode(code)) {
      const accepted = await recoveryCodes.verifyAndConsume(user.id, code);
      if (!accepted) {
        return res.status(403).json({ error: 'That backup code is not valid, or has already been used.' });
      }

      // The emailed code for this sign-in is spent along with it, so a code
      // sitting in an inbox cannot be replayed afterwards.
      await db.invalidateUserOtps(user.id);

      const ttlMs = sessionTtlFor(user);
      const recovered = await createSession(user.id, { ttlMs });
      await db.remove('sessions', session.id);
      res.cookie(SESSION_COOKIE, recovered.id, { ...COOKIE_OPTS, maxAge: ttlMs });

      const left = await recoveryCodes.statusFor(user.id);
      await audit(user.id, 'login', 'user', user.id, { via: 'recovery_code', remaining: left.remaining });

      // Loudly, to everyone else. Signing in this way is a break-glass event,
      // and one that happened quietly would be worse than no record at all.
      await admins.notifyAdmins(
        `${user.name} signed in with a backup code. ${left.remaining} of their codes remain.`,
        'security',
        { exceptUserId: user.id },
      );

      return res.json({
        user: safeUser(user),
        csrfToken: recovered.csrfToken,
        redirect: PORTAL_PATH[user.role] || '/portal.html',
        usedRecoveryCode: true,
        recoveryCodesRemaining: left.remaining,
      });
    }

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

    // A brand-new identifier at the moment access is granted, not the one that
    // existed while this person was still a stranger. The pending session is
    // destroyed rather than upgraded, so anything that knew the old value --
    // including whoever might have planted it -- holds a dead cookie.
    const session2 = await createSession(user.id, { ttlMs });
    await db.remove('sessions', session.id);
    res.cookie(SESSION_COOKIE, session2.id, { ...COOKIE_OPTS, maxAge: ttlMs });

    await audit(user.id, 'login', 'user', user.id, { via: 'otp' });

    // The one moment an admin is guaranteed to be looking. An account with no
    // backup codes is one mail outage away from being locked out, and the only
    // useful time to say so is now.
    const backup = roles.isAdmin(user) ? await recoveryCodes.statusFor(user.id) : null;

    res.json({
      user: safeUser(user),
      csrfToken: session2.csrfToken,
      redirect: PORTAL_PATH[user.role] || '/portal.html',
      ...(backup ? { recoveryCodesRemaining: backup.remaining } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The Login Codes page: the fallback for a workspace whose mail transport is
 * down, where an admin reads a client's code out to them on the phone.
 *
 * Two things are deliberately not on it.
 *
 * An administrator's own code never appears. Admins now sign in with a password
 * plus a code like everyone else, so a page that shows an admin's live code
 * would hand any other admin the whole account -- it would undo the second
 * factor rather than support it.
 *
 * The sign-in IP address is a super admin's to see. It is every user's rough
 * location and movements, and reading it is not part of "help this client get
 * in".
 */
router.get('/otp-logs', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const [otps, users] = await Promise.all([db.recent('otp_codes', 100), db.all('users')]);
    const usersById = new Map(users.map((u) => [u.id, u]));
    const showAddresses = roles.isSuperAdmin(req.user);

    const logs = otps
      .filter((o) => usersById.get(o.userId)?.role !== 'admin')
      .map((o) => {
        const u = usersById.get(o.userId);
        return {
          id: o.id,
          userId: o.userId,
          name: u?.name || 'Unknown user',
          email: u?.email || '-',
          ipAddress: showAddresses ? normalizeIp(o.ipAddress) : 'hidden',
          createdAt: o.createdAt,
          expiresAt: Number(o.expiresAt),
          consumed: o.consumed,
          attempts: o.attempts,
        };
      });
    res.json({ logs, addressesHidden: !showAddresses });
  } catch (err) {
    next(err);
  }
});

/**
 * Read one code out.
 *
 * Finishing somebody else's sign-in is impersonation however good the reason,
 * so this is not a power a five-minute-old account gets. It needs an admin the
 * workspace has actually vouched for, it is never available for another
 * administrator's code, and it has its own rate limit rather than sharing the
 * dashboard's.
 */
router.post(
  '/otp-logs/:id/reveal',
  requireAuth,
  requireRole('admin'),
  requireCSRF,
  sensitiveAdminLimiter,
  async (req, res, next) => {
    try {
      if (!roles.isTrustedAdmin(req.user)) {
        return res.status(403).json({
          error: 'Reading someone else’s sign-in code needs a trusted admin. Ask a colleague who has been vouched for.',
        });
      }

      const otp = await db.find('otp_codes', req.params.id);
      if (!otp) return res.status(404).json({ error: 'Not found' });

      const owner = await db.find('users', otp.userId);
      if (!owner || owner.role === 'admin') {
        return res.status(403).json({
          error: 'An administrator’s sign-in code cannot be revealed. That would be their second factor.',
        });
      }

      const code = decryptCode(otp.code);
      if (code === null) {
        return res.status(409).json({
          error: 'This code can no longer be read, most likely because the server restarted. Ask the client to sign in again for a fresh code.',
        });
      }
      await audit(req.user.id, 'reveal_otp', 'otp_codes', otp.id, {
        forUserId: otp.userId,
        forRole: owner.role,
      });
      // The account whose code was read is told it happened. A silent
      // impersonation aid is a very different thing from a supported one.
      await notify(otp.userId, `${req.user.name} read your sign-in code to help you sign in.`, 'security');
      res.json({ code });
    } catch (err) {
      next(err);
    }
  },
);

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
