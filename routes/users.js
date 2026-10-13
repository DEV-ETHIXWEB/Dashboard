'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();

const { db } = require('../db/setup');
const {
  requireAuth, requireRole, requireCSRF, safeUser, audit, notify, refreshSession, normalizeIp,
} = require('../middleware/auth');
const roles = require('../utils/roles');
const approvals = require('../utils/approvals');
const { CLIENT_PAGES, normalizeAllowedPages, parseAllowedPages, allowedPagesFor } = require('../utils/clientPages');
const clientMail = require('../utils/clientMail');
const mailer = require('../utils/mailer');
const messages = require('../utils/emailMessages');
const admins = require('../utils/admins');
const loginLinks = require('../utils/loginLinks');
const userFields = require('../utils/userFields');
const provisioning = require('../utils/userProvisioning');
const {
  sensitiveAdminLimiter, credentialIssueLimiter, recoveryCodeLimiter, avatarUploadLimiter,
} = require('../utils/rateLimits');
const recoveryCodes = require('../utils/recoveryCodes');
const erasure = require('../utils/userErasure');
const { baseUrl } = require('../utils/appUrl');
const multer = require('multer');
const passwordPolicy = require('../utils/passwordPolicy');
const passwordTokens = require('../utils/passwordTokens');
const passwordWatch = require('../utils/passwordWatch');
const avatarStore = require('../utils/avatarStore');
const imageValidation = require('../utils/imageValidation');
const credentialDelivery = require('../utils/credentialDelivery');
const { describeDevice, deviceKind } = require('../utils/userAgent');

/**
 * Held in memory, never on disk.
 *
 * Same choice routes/reports.js makes, for the same two reasons: the serverless
 * target has no writable filesystem worth the name, and a file that never lands
 * on disk cannot be left behind when a request fails halfway. The limit here is
 * multer's own first line of defence -- utils/imageValidation.js checks the
 * size again, because a limit enforced in one place is a limit that moves when
 * somebody adds a second upload route.
 */
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imageValidation.MAX_BYTES, files: 1 },
});

/**
 * Multer's own limits, translated into this API's error shape.
 *
 * Multer rejects an oversized file from inside its middleware, before the route
 * handler exists to catch anything -- so a `try` in the handler never sees it
 * and the blanket 500 in server.js answers "something went wrong on the server"
 * to a request where nothing went wrong on the server at all. Running it as a
 * nested call is what puts the failure back where it can be described properly.
 */
function acceptAvatarFile(req, res, next) {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(imageValidation.MAX_BYTES / (1024 * 1024));
      return res.status(413).json({ error: `That picture is larger than ${mb}MB. Crop it or save it smaller and try again.` });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Send one image, in a field named "avatar".' });
    }
    return next(err);
  });
}

/**
 * Open the link, and the address moves.
 *
 * Deliberately not behind `requireAuth`: somebody confirming a new address may
 * well be reading the email on a device that has never signed in, and making
 * them log in first -- with the address that is about to change -- is a loop.
 * The token is the authentication, which is the same bargain every link in
 * this application makes.
 *
 * Every open session except the one making the request is ended. An email
 * change is the event a stolen session would be used for, so if this one was
 * not the owner's, the owner signing in afterwards closes it.
 */
router.post('/me/email/confirm', async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) return res.status(400).json({ error: 'That link is missing its token.' });

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const matches = await db.where('users', { pendingEmailHash: hash });
    const user = matches[0] || null;

    // One sentence for every way this can fail, so a guess learns nothing
    // about which addresses exist or which links are live.
    const expired = user?.pendingEmailExpiresAt
      && new Date(user.pendingEmailExpiresAt).getTime() < Date.now();
    if (!user || !user.pendingEmail || expired) {
      return res.status(400).json({ error: 'That link has expired or has already been used.' });
    }

    // Somebody else may have taken the address in the meantime.
    const taken = await db.filter(
      'users',
      (u) => u.id !== user.id && String(u.email).toLowerCase() === String(user.pendingEmail).toLowerCase(),
    );
    if (taken.length > 0) {
      await db.update('users', user.id, {
        pendingEmail: null, pendingEmailHash: null, pendingEmailExpiresAt: null,
      });
      return res.status(409).json({ error: 'That email is now in use by another account.' });
    }

    const previousEmail = user.email;
    const updated = await db.update('users', user.id, {
      email: user.pendingEmail,
      pendingEmail: null,
      pendingEmailHash: null,
      pendingEmailExpiresAt: null,
    });

    // Every other session goes. See the note above.
    await db.removeWhere('sessions', (s) => s.userId === user.id && s.id !== req.session?.id);

    await audit(user.id, 'update', 'user', user.id, {
      action: 'email_changed', from: previousEmail, to: updated.email,
    });

    // And the address they left keeps one last message, which is the only
    // thing that reaches the real owner if this was not them.
    try {
      await mailer.sendTemplate({
        to: previousEmail,
        message: messages.emailChanged({ user: updated, previousEmail }),
        template: 'email_changed',
        entity: 'user',
        entityId: user.id,
      });
    } catch (err) {
      console.error('Could not confirm the email change to the old address:', err.message);
    }

    res.json({ ok: true, email: updated.email });
  } catch (err) {
    next(err);
  }
});

router.use(requireAuth);

/** Turn an AdminError (last-admin guard) into its own status, not a 500. */
function handleAdmin(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof admins.AdminError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}

/**
 * Every administrator hears about a change to the administrator roster --
 * that is the whole point of a shared admin workspace rather than one owner.
 */
async function announceRosterChange({ actor, target, change }) {
  try {
    const count = await admins.countAdmins();
    await admins.notifyAdmins(
      change === 'added'
        ? `${actor.name} made ${target.name} an administrator`
        : `${actor.name} removed administrator access from ${target.name}`,
      'admin',
      { exceptUserId: actor.id },
    );
    const inboxes = await admins.adminEmails({ exclude: [actor.email] });
    if (inboxes.length === 0) return;
    await mailer.sendTemplate({
      to: inboxes,
      message: messages.adminRosterChanged({
        actorName: actor.name,
        targetName: target.name,
        targetEmail: target.email,
        change,
        adminCount: count,
      }),
      template: 'admin_roster',
      entity: 'user',
      entityId: target.id,
    });
  } catch (err) {
    console.error('Could not announce the admin roster change:', err.message);
  }
}

const { isFirebaseAdminConfigured, verifyFirebaseIdToken } = require('../utils/firebaseAdmin');

router.post('/me/2fa/enable', requireCSRF, async (req, res, next) => {
  try {
    if (!isFirebaseAdminConfigured()) {
      return res.status(503).json({ error: 'Two-factor authentication is not configured on the server yet.' });
    }
    const { firebaseIdToken } = req.body || {};
    if (!firebaseIdToken) return res.status(400).json({ error: 'firebaseIdToken is required' });

    const decoded = await verifyFirebaseIdToken(firebaseIdToken);
    const contact = decoded.phone_number || decoded.email;
    if (!contact) return res.status(400).json({ error: 'Could not determine a verified phone or email from that token.' });

    const updated = await db.update('users', req.user.id, { twoFactorEnabled: true, twoFactorContact: contact });
    await audit(req.user.id, 'update', 'user', req.user.id, { action: '2fa_enabled' });
    res.json({ user: safeUser(updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * Turning the second factor off, which needs more than the session that it
 * exists to protect.
 *
 * It used to need only a signed-in cookie. That is the wrong way round: the
 * whole purpose of a second factor is to be worth something when a session has
 * been taken, and a protection that can be removed by the thing it is
 * protecting against is decoration. Switching it ON is already proven with a
 * verified Firebase token; switching it off was free.
 *
 * The password is what is asked for, because it is the one thing a borrowed
 * session does not carry. An account that signs in with Google has none, and
 * is sent to an administrator rather than waved through -- a person in the
 * loop is the point.
 *
 * The old address is told either way: if this was not the owner, that message
 * is how they find out.
 */
router.post('/me/2fa/disable', requireCSRF, async (req, res, next) => {
  try {
    if (!req.user.twoFactorEnabled) {
      return res.json({ user: safeUser(req.user) });
    }

    const { currentPassword } = req.body || {};
    if (!req.user.password) {
      return res.status(400).json({
        error: 'This account signs in with Google, so there is no password to confirm with. '
          + 'Ask an administrator to turn two-step verification off.',
      });
    }
    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password)) {
      return res.status(403).json({
        error: 'Enter your current password to turn two-step verification off.',
      });
    }

    const updated = await db.update('users', req.user.id, { twoFactorEnabled: false, twoFactorContact: null });
    await audit(req.user.id, 'update', 'user', req.user.id, { action: '2fa_disabled' });

    try {
      await mailer.sendTemplate({
        to: updated.email,
        message: messages.twoFactorDisabled({ user: updated, ipAddress: normalizeIp(req.ip) }),
        template: 'two_factor_disabled',
        entity: 'user',
        entityId: req.user.id,
      });
    } catch (err) {
      console.error('Could not send the two-step-verification notice:', err.message);
    }

    res.json({ user: safeUser(updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * Backup codes: how many are left.
 *
 * Never the codes themselves. They are shown once, at the moment they are
 * generated, and after that the server genuinely cannot produce them -- only
 * their hashes are kept. A page that could re-display them would make the
 * screen as good as the codes.
 */
router.get('/me/recovery-codes', async (req, res, next) => {
  try {
    if (!roles.isAdmin(req.user)) {
      return res.status(403).json({ error: 'Backup codes are for administrator accounts.' });
    }
    res.json({ status: await recoveryCodes.statusFor(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Generate a fresh set, replacing any earlier one.
 *
 * Your own account only. An admin who could generate codes for another admin
 * would be minting themselves a way into that account, which is the same power
 * the password reset was locked down for.
 */
router.post('/me/recovery-codes', requireCSRF, recoveryCodeLimiter, async (req, res, next) => {
  try {
    if (!roles.isAdmin(req.user)) {
      return res.status(403).json({ error: 'Backup codes are for administrator accounts.' });
    }

    const previous = await recoveryCodes.statusFor(req.user.id);
    const codes = await recoveryCodes.issueFor(req.user.id);

    await audit(req.user.id, 'recovery_codes', 'user', req.user.id, {
      action: 'regenerated',
      count: codes.length,
      replaced: previous.total,
    });
    // Every other admin hears about it. A new set silently replacing an old one
    // is indistinguishable from somebody who has taken the account doing the
    // same thing.
    await admins.notifyAdmins(
      `${req.user.name} generated a new set of sign-in backup codes.`,
      'security',
      { exceptUserId: req.user.id },
    );

    res.json({ codes, status: await recoveryCodes.statusFor(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/** How long a confirmation link to a new address is good for. */
const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;

/**
 * Park the new address and send the two emails that make the change safe.
 *
 * Only the SHA-256 of the link's secret is written down, the same way
 * utils/passwordTokens.js does it, so a database leak yields nothing that can
 * be replayed into an account takeover. The secret travels in the URL
 * fragment, which no browser sends to a server -- it stays out of access logs
 * and out of `Referer` headers on any onward click.
 *
 * Never throws. The rest of the profile save has already happened, and a mail
 * transport that is down must not turn it into an error; the address simply
 * does not move, which is the safe outcome.
 */
async function startEmailChange(req, user, nextEmail) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS).toISOString();

  await db.update('users', user.id, {
    pendingEmail: nextEmail,
    pendingEmailHash: hash,
    pendingEmailExpiresAt: expiresAt,
  });

  const base = baseUrl();
  const confirmUrl = base ? `${base}/confirm-email#token=${secret}` : null;

  // To the new address: the link that actually moves it.
  try {
    await mailer.sendTemplate({
      to: nextEmail,
      message: messages.confirmEmailChange({
        user, nextEmail, confirmUrl, expiresAt, ipAddress: normalizeIp(req.ip),
      }),
      template: 'confirm_email_change',
      entity: 'user',
      entityId: user.id,
    });
  } catch (err) {
    console.error(`Could not send the email-change confirmation to ${nextEmail}:`, err.message);
    return false;
  }

  /**
   * To the old address: that somebody asked.
   *
   * The half that matters when the session was not the owner's. The link goes
   * to an inbox the attacker controls, so the only person it can reach is the
   * one being attacked -- and they are the one who needs to know.
   */
  try {
    await mailer.sendTemplate({
      to: user.email,
      message: messages.emailChangeRequested({
        user, nextEmail, ipAddress: normalizeIp(req.ip),
      }),
      template: 'email_change_requested',
      entity: 'user',
      entityId: user.id,
    });
  } catch (err) {
    console.error('Could not warn the old address about an email change:', err.message);
  }

  return true;
}

router.put('/me', requireCSRF, async (req, res, next) => {
  try {
    const { name, email, password, currentPassword } = req.body || {};
    const patch = {};

    if (name !== undefined && name !== null && name !== '') {
      const cleanName = userFields.normalizeName(name);
      if (!cleanName) return res.status(400).json({ error: 'Name must be some text.' });
      patch.name = cleanName;
    }

    /**
     * Changing the email is a request, not a write.
     *
     * It used to be one field in this patch: no password, no confirmation to
     * the new address, no word to the old one. A session somebody had borrowed
     * for five minutes could therefore be turned into the account itself --
     * move the address, ask for a password reset, and the real owner is locked
     * out of their own workspace with no notification that anything happened.
     *
     * Three things now stand between a session and that:
     *
     *   the current password   so holding the cookie is not enough,
     *   a link to the new      so the address has to be one they can read,
     *   a notice to the old    so the real owner finds out either way.
     *
     * Nothing is written to `email` here. The address is parked in
     * `pending_email` and only moves when the link is opened.
     */
    let emailChange = null;
    if (email !== undefined && email !== null && email !== '') {
      const cleanEmail = userFields.normalizeEmail(email);
      if (!cleanEmail) return res.status(400).json({ error: 'That is not a valid email address.' });

      if (cleanEmail !== String(req.user.email).toLowerCase()) {
        // Proving the current password. An account that signs in with Google
        // has none to prove, so it cannot take this route at all -- the change
        // has to go through an administrator, which is a person rather than a
        // borrowed cookie.
        if (!req.user.password) {
          return res.status(400).json({
            error: 'This account signs in with Google, so there is no password to confirm the '
              + 'change with. Ask an administrator to move the address.',
          });
        }
        if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password)) {
          return res.status(403).json({ error: 'Enter your current password to change your email address.' });
        }

        const taken = await db.filter(
          'users',
          (u) => u.id !== req.user.id && String(u.email).toLowerCase() === cleanEmail,
        );
        if (taken.length > 0) return res.status(409).json({ error: 'That email is already in use' });

        emailChange = cleanEmail;
      }
    }

    // A new password requires proving the current one, so a borrowed session
    // cannot lock the real owner out.
    if (password) {
      if (!req.user.password) {
        return res.status(400).json({ error: 'This account signs in with Google, so it has no password to change.' });
      }
      if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.password)) {
        return res.status(403).json({ error: 'Your current password is not correct' });
      }
      // The policy applies to a password somebody chose for themselves exactly
      // as much as to one a link set. This is the screen people are pushed to
      // when theirs expires, so a weak password accepted here would be a hole
      // straight through the rotation it exists to serve.
      const rejection = passwordPolicy.rejectionFor(password, {
        email: patch.email || req.user.email,
        name: patch.name || req.user.name,
      });
      if (rejection) return res.status(422).json({ error: rejection });
      if (bcrypt.compareSync(password, req.user.password)) {
        return res.status(422).json({ error: 'That is the password you already have. Choose a different one.' });
      }

      // Stamps the age and clears any outstanding "you must reset" flag, so
      // changing it here is a real way out of the block in middleware/auth.js.
      Object.assign(patch, passwordPolicy.stampChange({ password: bcrypt.hashSync(password, 10) }));
    }

    const updated = await db.update('users', req.user.id, patch);

    // Any other session of this user dies with the old password.
    if (patch.password) {
      await db.removeWhere('sessions', (s) => s.userId === req.user.id && s.id !== req.session.id);
      // And every link that could set it again. A reset email still sitting in
      // an inbox is a second key to a lock that was just changed.
      await passwordTokens.revokeAllFor(req.user.id);

      // Best-effort: the password has already moved, and a mail transport that
      // is down must not turn a successful change into an error.
      try {
        await mailer.sendTemplate({
          to: updated.email,
          message: messages.passwordChanged({ user: updated, at: Date.now(), ipAddress: normalizeIp(req.ip), via: 'self' }),
          template: 'password_changed',
          entity: 'user',
          entityId: req.user.id,
        });
      } catch (err) {
        console.error('Could not send the password-changed confirmation:', err.message);
      }
    }

    // The address does not move until the link is opened. Both emails go out
    // here, and neither is allowed to fail the rest of the save.
    let emailPending = false;
    if (emailChange) {
      emailPending = await startEmailChange(req, updated, emailChange);
    }

    await audit(req.user.id, 'update', 'user', req.user.id, {
      self: true,
      passwordChanged: Boolean(patch.password),
      ...(emailChange ? { emailChangeRequested: emailChange } : {}),
    });
    res.json({
      user: safeUser(await db.find('users', req.user.id)),
      // So the screen can say "check your new inbox" rather than showing the
      // old address back and looking as though nothing happened.
      emailChangePending: emailPending ? emailChange : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Everything the profile page shows, in one read.
 *
 * Your own account and nothing else -- there is no `:id` form of this, on
 * purpose. An admin who wants to know about somebody else's password standing
 * gets it from the user list, which already carries the same status object and
 * carries nothing this endpoint adds: sessions, device list, and the person's
 * own activity are theirs.
 *
 * What is deliberately absent: role or standing details about anybody else,
 * anything from the audit log that was not about this account, and any hint of
 * a token or a hash.
 */
router.get('/me/profile', async (req, res, next) => {
  try {
    /**
     * This account's own rows, asked for by actor.
     *
     * `db.recent('activity_log', 400)` was the last 400 entries in the *whole
     * workspace*, filtered afterwards to the ones about this person -- so on a
     * busy afternoon somebody's own security history was empty, because four
     * hundred other people's events had happened since. The page is a record
     * of your own sign-ins and it silently stopped being one exactly when
     * there was most to look at.
     *
     * Entries about this account that somebody else performed -- an admin
     * resetting a password -- are the second read. Both are indexed; see the
     * activity_log indexes in db/setup.js.
     */
    const [sessions, byMe, aboutMe] = await Promise.all([
      db.where('sessions', { userId: req.user.id }),
      db.where('activity_log', { actorId: req.user.id }, { orderBy: 'createdAt', limit: 200 }),
      db.where('activity_log', { entity: 'user', entityId: req.user.id }, { orderBy: 'createdAt', limit: 200 }),
    ]);

    const seen = new Set();
    const log = [...byMe, ...aboutMe]
      .filter((row) => (seen.has(row.id) ? false : seen.add(row.id)))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const mine = log.filter((row) => isOwnSecurityEvent(row, req.user.id));
    const lastLogin = mine.find((row) => row.action === 'login' && row.actorId === req.user.id) || null;

    const delivery = await credentialDelivery.pendingFor(req.user.id);

    res.json({
      user: safeUser(req.user),
      passwordStatus: passwordPolicy.statusFor(req.user),
      avatar: await avatarStore.metaFor(req.user.id),
      lastLoginAt: lastLogin ? lastLogin.createdAt : null,
      // Ordered newest first by db.recent already; the cap is what a person can
      // actually read rather than a full history export.
      activity: mine.slice(0, 25).map((row) => publicActivity(row, req.user.id)),
      sessions: sessions
        .filter((s) => !s.pending)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
        .map((s) => ({
          id: s.id,
          createdAt: Number(s.createdAt),
          expiresAt: Number(s.expiresAt),
          // The only one of these the person is looking through right now.
          current: s.id === req.session.id,
          // Named so this list can do its job. A row nobody recognises is the
          // entire reason the list exists, and "another device" describes the
          // laptop in front of them and a stranger's phone equally well. The
          // user agent is self-reported and never authorises anything -- see
          // utils/userAgent.js -- and only its owner is ever shown it.
          device: describeDevice(s.userAgent),
          deviceKind: deviceKind(s.userAgent),
          ipAddress: s.ipAddress || null,
        })),
      // Present so the page can say "a link is on its way on Tuesday" rather
      // than leaving somebody wondering. Status only, never the link.
      pendingDelivery: delivery ? credentialDelivery.publicDelivery(delivery) : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Audit actions a person is entitled to see about their own account.
 *
 * An allowlist rather than a filter on what to hide, because the log grows and
 * a deny-list quietly leaks whatever was added last. Everything here is either
 * something they did or something done to their credentials -- which they
 * should know about precisely so that an unfamiliar entry is alarming.
 */
const OWN_SECURITY_ACTIONS = new Set([
  'login',
  'logout',
  'password_reset',
  'password_reset_requested',
  'password_expired',
  'recovery_codes',
  'avatar_updated',
  'avatar_removed',
  'issue_login_link',
  'reveal_otp',
  'credential_delivery_sent',
  'credential_delivery_scheduled',
  'credential_delivery_cancelled',
]);

function isOwnSecurityEvent(row, userId) {
  if (!OWN_SECURITY_ACTIONS.has(row.action)) return false;
  if (row.actorId === userId) return true;
  // Done *to* this account by somebody else -- an admin scheduling credentials,
  // reading a sign-in code, minting a link. Exactly the entries worth seeing.
  return row.entity === 'user' && row.entityId === userId;
}

/**
 * One activity row, stripped for its subject.
 *
 * The meta on an audit row is written for an administrator reading the full
 * log, and can name other accounts, roles and internal fields. None of that is
 * this person's business, so none of it travels: what is left is what happened,
 * when, and whether they were the one who did it.
 */
function publicActivity(row, userId) {
  return {
    id: row.id,
    action: row.action,
    createdAt: row.createdAt,
    bySelf: row.actorId === userId,
    // Never a name or an id. "Somebody with administrative access did this" is
    // the whole of what a non-admin needs, and naming the colleague turns the
    // profile page into a partial staff directory.
    actor: row.actorId === userId ? 'You' : row.actorId ? 'An administrator' : 'The system',
  };
}

/**
 * Sign out everywhere else.
 *
 * The session running this request survives, so the person is not thrown out
 * of the page they clicked the button on -- which sounds like a nicety and is
 * actually the difference between a control people use and one they avoid.
 */
router.delete('/me/sessions', requireCSRF, async (req, res, next) => {
  try {
    const others = await db.filter(
      'sessions',
      (s) => s.userId === req.user.id && s.id !== req.session.id,
    );
    for (const session of others) await db.remove('sessions', session.id);

    await audit(req.user.id, 'sessions_revoked', 'user', req.user.id, { count: others.length, self: true });
    res.json({ ok: true, revoked: others.length });
  } catch (err) {
    next(err);
  }
});

// --- profile pictures ------------------------------------------------------

/** `me` is an alias for your own id, so the browser never has to look it up. */
function resolveUserId(req) {
  return req.params.id === 'me' ? req.user.id : req.params.id;
}

/**
 * Who may change this picture: its owner, or an administrator.
 *
 * The admin case is not vanity -- somebody has to be able to take down a
 * picture that should not be there, and the person who uploaded it is the last
 * one who will. One administrator editing another's is left to super admins,
 * matching every other admin-on-admin rule in this file.
 */
function avatarRefusal(actor, targetId, target) {
  if (actor.id === targetId) return null;
  if (!roles.isAdmin(actor)) return 'You can only change your own profile picture.';
  if (target && target.role === 'admin' && !roles.canManageAdmins(actor)) {
    return 'Only a super admin can change another administrator’s profile picture.';
  }
  return null;
}

/**
 * The picture itself.
 *
 * Signed-in callers only: these are colleagues' and clients' faces, and an
 * open endpoint would make them enumerable by user id from anywhere. The
 * response is cached privately and briefly -- long enough that a table of
 * thirty avatars is not thirty requests on every navigation, short enough that
 * a replacement appears quickly. The URL carries `?v=<avatarUpdatedAt>`
 * anyway, so a replaced picture is a different URL and the cache is bypassed
 * entirely rather than waited out.
 */
router.get('/:id/avatar', async (req, res, next) => {
  try {
    const userId = resolveUserId(req);
    const stored = await avatarStore.load(userId);
    // Not an error: an account with no picture is the normal case, and the
    // browser falls back to the initials the page already renders.
    if (!stored) return res.status(404).json({ error: 'No profile picture' });

    // Overrides the blanket `no-store` that server.js puts on every /api
    // response. Private, so a shared proxy never holds one person's face.
    res.setHeader('Cache-Control', 'private, max-age=300');
    // The type the validator decided when this was stored -- never one the
    // uploader supplied. Paired with helmet's nosniff, that is what makes
    // serving somebody else's bytes back to a browser safe.
    res.setHeader('Content-Type', stored.mimeType);
    res.setHeader('Content-Disposition', 'inline; filename="avatar"');
    if (stored.checksum) res.setHeader('ETag', `"${stored.checksum}"`);
    res.send(stored.buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * Upload or replace a picture.
 *
 * The browser has already scaled the image down (frontend/src/lib/avatar.ts),
 * so what arrives is normally 256px and a few tens of kilobytes. Nothing here
 * relies on that: the bytes are validated as if they had been posted by hand
 * with curl, because they can be.
 */
router.post(
  '/:id/avatar',
  requireCSRF,
  avatarUploadLimiter,
  acceptAvatarFile,
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);
      const target = await db.find('users', userId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      const refusal = avatarRefusal(req.user, userId, target);
      if (refusal) return res.status(403).json({ error: refusal });

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'No image was uploaded.' });
      }

      // The filename and the declared type are both the uploader's choice, so
      // neither is consulted. The bytes decide.
      const verdict = imageValidation.validateAvatar(req.file.buffer);
      if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

      const saved = await avatarStore.save(userId, {
        buffer: req.file.buffer,
        image: verdict.image,
        actorId: req.user.id,
      });

      await audit(req.user.id, 'avatar_updated', 'user', userId, {
        self: req.user.id === userId,
        // Facts about the file, never the file.
        format: verdict.image.format,
        width: verdict.image.width,
        height: verdict.image.height,
        sizeBytes: req.file.size,
      });

      // Their other tabs, and every list showing them, redraw with the new face.
      refreshSession(userId);

      res.status(201).json({
        avatar: {
          userId,
          mimeType: saved.mimeType,
          width: saved.width,
          height: saved.height,
          sizeBytes: saved.sizeBytes,
          updatedAt: saved.updatedAt,
        },
        avatarUpdatedAt: saved.avatarUpdatedAt,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Take the picture down. Falls back to initials, which never fail. */
router.delete('/:id/avatar', requireCSRF, async (req, res, next) => {
  try {
    const userId = resolveUserId(req);
    const target = await db.find('users', userId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const refusal = avatarRefusal(req.user, userId, target);
    if (refusal) return res.status(403).json({ error: refusal });

    const removed = await avatarStore.remove(userId);
    if (removed) {
      await audit(req.user.id, 'avatar_removed', 'user', userId, { self: req.user.id === userId });
      refreshSession(userId);
    }
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
});

/** The toggle list an admin sees when issuing or editing a client login. */
router.get('/client-pages', (req, res) => {
  res.json({ pages: CLIENT_PAGES.map(({ key, label, description }) => ({ key, label, description })) });
});

/**
 * The people list, in three widths.
 *
 * An admin gets the full records, because managing accounts is the job. Staff
 * get the internal directory, because assigning work needs names. A client
 * gets themselves plus the specific colleagues already working on their
 * account -- and nothing else.
 *
 * That last one used to be the same list staff see: every employee and every
 * administrator, each with their role attached. An outside customer was handed
 * the internal team roster and told which two people to phish.
 */
router.get('/', async (req, res, next) => {
  try {
    const users = await db.all('users');

    if (req.user.role === 'admin') {
      // The people list is the busiest admin read in the app, which makes it
      // the right place to hang the sweeps off: any admin looking at the
      // workspace is enough to notice a password that aged out overnight or a
      // delivery that came due. Both are throttled to one pass per interval and
      // neither is awaited -- the same arrangement utils/slaWatch.js has always
      // used, and for the same reason: nobody should wait on a mail server to
      // see a table.
      void passwordWatch.maybeSweep();
      void require('../utils/credentialScheduler').maybeSweep();

      // One query rather than one per row: the pending delivery for each
      // account, so the list can show "scheduled for Tuesday" without the page
      // making a second request per person.
      const deliveries = await db.all('credential_deliveries');
      const pendingByUser = new Map();
      for (const row of deliveries) {
        if (!['scheduled', 'sending'].includes(row.status)) continue;
        const seen = pendingByUser.get(row.userId);
        if (!seen || Number(row.scheduledAt) > Number(seen.scheduledAt)) pendingByUser.set(row.userId, row);
      }

      return res.json({
        users: users.map((u) => ({
          ...safeUser(u),
          allowedPages: parseAllowedPages(u.allowedPages),
          credentialDelivery: credentialDelivery.publicDelivery(pendingByUser.get(u.id) || null),
        })),
      });
    }

    if (req.user.role === 'client') {
      // Whoever this client can already see the work of: the manager on their
      // projects, and the person handling each of their tickets. Names, so the
      // portal can say who replied -- never the role, so the roster stays shut.
      // Asked for by client, not read whole and filtered. This list is three
      // names long and it was scanning every project and every ticket in the
      // workspace to build it -- on Firestore, a billed read per row.
      const [projects, tickets] = await Promise.all([
        db.where('projects', { clientId: req.user.id }, { select: ['assignedPmId'] }),
        db.where('tickets', { clientId: req.user.id }, { select: ['assigneeId'] }),
      ]);
      const connected = new Set();
      for (const p of projects) if (p.assignedPmId) connected.add(p.assignedPmId);
      for (const t of tickets) if (t.assigneeId) connected.add(t.assigneeId);

      const self = users.find((u) => u.id === req.user.id);
      const visible = [
        ...(self ? [{ id: self.id, name: self.name, role: self.role, company: self.company || null }] : []),
        ...users
          .filter((u) => u.role !== 'client' && connected.has(u.id))
          .map((u) => ({ id: u.id, name: u.name, role: 'staff', company: null })),
      ];
      return res.json({ users: visible });
    }

    const directory = users
      .filter((u) => u.role !== 'client' || u.id === req.user.id)
      .map((u) => ({ id: u.id, name: u.name, role: u.role, company: u.company || null }));
    res.json({ users: directory });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin'), credentialIssueLimiter, async (req, res, next) => {
  try {
    const {
      role, company, password, passwordExpiresAt, allowedPages, sendEmail,
      slackChannelId, slackChannelName, mailEnabled,
    } = req.body || {};
    const { name: rawName, email: rawEmail } = req.body || {};
    if (!rawName || !rawEmail || !role) return res.status(400).json({ error: 'name, email, and role are required' });
    const validRoles = ['admin', 'sales', 'project_manager', 'employee', 'client'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (passwordExpiresAt !== undefined && passwordExpiresAt !== null && !Number.isFinite(Number(passwordExpiresAt))) {
      return res.status(400).json({ error: 'passwordExpiresAt must be a timestamp or null' });
    }

    // The address has to be an address before anything else happens, because
    // everything downstream assumes it is one: it is how this person signs in,
    // and it is where their password is about to be sent. A body carrying a
    // number or an object here used to reach `email.toLowerCase()` below and
    // come back as a 500; worse, on the editing routes it was stored, and an
    // account whose address is the string "true" can never be reached or
    // logged into again.
    const name = userFields.normalizeName(rawName);
    if (!name) return res.status(400).json({ error: 'Name must be some text.' });
    const email = userFields.normalizeEmail(rawEmail);
    if (!email) return res.status(400).json({ error: 'That is not a valid email address.' });

    const existing = await db.filter('users', (u) => String(u.email).toLowerCase() === email);
    if (existing.length > 0) return res.status(409).json({ error: 'A user with that email already exists' });

    // Appointing an administrator is the one thing an ordinary admin cannot do
    // at all, approval or not. Only a super admin grows the admin roster.
    if (role === 'admin' && !roles.canManageAdmins(req.user)) {
      return res.status(403).json({ error: 'Only a super admin can create an administrator.' });
    }

    /**
     * Whether this client may be emailed at all.
     *
     * Off by default for a new client, and only for a client. Accounts are
     * created in here before anybody has agreed to pay for anything -- a site
     * already running on our servers gets a profile so there is something to
     * hang its domains and payments on -- and a welcome email to somebody who
     * never signed up for a dashboard is the one thing that must not happen.
     * An admin turns it on when they take a membership.
     *
     * Staff are never gated, so the column stays null for them.
     */
    const mailOn = role === 'client' ? mailEnabled === true : null;

    // Page toggles only mean anything for clients; staff always see their whole role.
    let pages;
    try {
      pages = role === 'client' ? normalizeAllowedPages(allowedPages) : null;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    /**
     * A password an admin typed is held to the same policy as one somebody
     * sets for themselves.
     *
     * The edit route already does this; creation did not, so the weakest
     * password in the workspace could be set on the day an account was made --
     * and that is the one the account is emailed and most likely to keep. An
     * admin typing "password1" for a colleague is the same weakness as the
     * colleague typing it.
     *
     * A *generated* password skips the check because it is generated to pass
     * it; see utils/userProvisioning.js.
     */
    if (password) {
      const rejection = passwordPolicy.rejectionFor(password, { email, name });
      if (rejection) return res.status(422).json({ error: rejection });
    }

    const plaintextPassword = password || provisioning.generatePassword();

    // An admin nobody has vouched for yet proposes; somebody else releases it.
    const gate = await approvals.gate(req, res, {
      action: 'user.create',
      summary: `Create a ${role} account for ${name} (${email})`,
      payload: {
        name, email, role, company: company || null, plaintextPassword,
        passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
        allowedPages: pages === undefined ? null : pages,
        mailEnabled: mailOn,
        ...(role === 'client' ? normaliseChannel(slackChannelId, slackChannelName) : {}),
      },
    });
    if (gate.held) return;

    const user = await provisioning.createUserRecord({
      name, email, role, company: company || null, plaintextPassword,
      passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
      allowedPages: pages === undefined ? null : pages,
      mailEnabled: mailOn,
      ...(role === 'client' ? normaliseChannel(slackChannelId, slackChannelName) : {}),
    });
    await audit(req.user.id, 'create', 'user', user.id, {
      role,
      ...(pages ? { allowedPages: pages } : {}),
    });

    // Get the bot into the channel now, while an admin is here to read the
    // answer, rather than at the moment the client first opens Messages.
    const joined = await provisioning.joinAssignedChannel(user);

    // Their dashboard and the plans, in one message. Sent now because intent
    // is highest the moment an account exists, and sent once -- the timestamp
    // on the account is what stops the first-login trigger repeating it.
    await provisioning.welcomeNewClient(user);

    // Default to emailing the credentials; an admin can opt out and hand them
    // over in person instead.
    const emailed = sendEmail === false
      ? false
      : await provisioning.emailCredentials(user, plaintextPassword, { invitedBy: req.user.name, ipAddress: req.ip });

    if (role === 'admin') await announceRosterChange({ actor: req.user, target: user, change: 'added' });

    // An administrator is issued backup codes with their password, and for the
    // same reason: they are the account that cannot ask anyone else for help
    // getting back in. Shown once, here, alongside the password. The new admin
    // can replace them from their own Security page, which is what they should
    // do if these were read over someone's shoulder.
    const backupCodes = role === 'admin' ? await recoveryCodes.issueFor(user.id) : null;

    res.status(201).json({
      user: { ...safeUser(user), allowedPages: parseAllowedPages(user.allowedPages) },
      temporaryPassword: plaintextPassword,
      ...(backupCodes ? { recoveryCodes: backupCodes } : {}),
      emailed,
      emailConfigured: mailer.isEnabled(),
      ...(joined ? { slackChannel: joined } : {}),
    });
  } catch (err) {
    if (err instanceof admins.AdminError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Edit somebody else's account.
 *
 * Three separate boundaries meet on this one route, and they are checked in
 * this order because each is meaningless without the one above it:
 *
 *   1. Which fields may be written at all. The body is never copied onto the
 *      row; only the names in utils/userFields.js survive. Admin standing is
 *      not among them, at any spelling.
 *   2. Who may touch this particular account. Another administrator's account
 *      -- their password above all -- is a super admin's business alone.
 *   3. Whether this administrator may act unsupervised, or whether the change
 *      is parked for a second signature.
 */
router.put('/:id', requireCSRF, requireRole('admin'), credentialIssueLimiter, handleAdmin(async (req, res) => {
  const body = req.body || {};

  // Refuse by name rather than dropping silently. A caller reaching for
  // `isSuperAdmin` -- or `is_super_admin`, or any other spelling of it -- gets
  // told where that actually lives instead of a 200 that changed nothing.
  const refused = userFields.unknownFields(body);
  if (refused.length > 0) {
    return res.status(400).json({
      error: `These fields cannot be set here: ${refused.join(', ')}. `
        + 'Admin standing is changed on the standing endpoint, and a password is changed on your own profile.',
      fields: refused,
    });
  }

  const patch = userFields.pickEditable(body);
  const sendEmail = body.sendEmail;

  const before = await db.find('users', req.params.id);
  if (!before) return res.status(404).json({ error: 'User not found' });

  const isSelf = before.id === req.user.id;

  // An administrator's account is not ordinary user data. Resetting its
  // password hands the account over outright -- admins sign in with a password
  // plus an emailed code, and the person doing the reset is the one who reads
  // the new password off the screen. So every edit of another admin, not only
  // the password, belongs to whoever may appoint admins in the first place.
  if (before.role === 'admin' && !isSelf && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({
      error: 'Only a super admin can change another administrator’s account.',
    });
  }

  // Moving the last administrator off the admin role would lock the whole
  // workspace out of user management.
  if (patch.role && patch.role !== before.role) {
    await admins.assertRosterSurvives(req.params.id, { nextRole: patch.role });
  }

  if (patch.role !== undefined) {
    const validRoles = ['admin', 'sales', 'project_manager', 'employee', 'client'];
    if (!validRoles.includes(patch.role)) return res.status(400).json({ error: 'Invalid role' });
  }

  if (patch.passwordExpiresAt !== undefined && patch.passwordExpiresAt !== null && !Number.isFinite(Number(patch.passwordExpiresAt))) {
    return res.status(400).json({ error: 'passwordExpiresAt must be a timestamp or null' });
  }
  if (patch.passwordExpiresAt != null) patch.passwordExpiresAt = Number(patch.passwordExpiresAt);

  // An address is how somebody signs in, so it has to be an address.
  //
  // Without this, `{"email": true}` was written to the row as the string
  // "true" and `{"email": {}}` as "{}" -- both of which lock the account out
  // of the product as well as out of its inbox, and neither of which anybody
  // notices until that client tries to sign in. The same applied to `name`,
  // which is printed on every screen and in every message we send them.
  if (patch.name !== undefined) {
    const cleanName = userFields.normalizeName(patch.name);
    if (!cleanName) return res.status(400).json({ error: 'Name must be some text.' });
    patch.name = cleanName;
  }

  if (patch.email !== undefined) {
    const cleanEmail = userFields.normalizeEmail(patch.email);
    if (!cleanEmail) return res.status(400).json({ error: 'That is not a valid email address.' });
    patch.email = cleanEmail;
  }

  // Taking an address another account already uses would lock that account
  // out. The self-service profile screen has always said so; this one used to
  // let the database raise it as a 500 instead.
  if (patch.email && patch.email !== String(before.email).toLowerCase()) {
    const taken = await db.filter(
      'users',
      (u) => u.id !== req.params.id && String(u.email).toLowerCase() === patch.email,
    );
    if (taken.length > 0) return res.status(409).json({ error: 'That email is already in use' });
  }

  if ('slackChannelId' in patch || 'slackChannelName' in patch) {
    Object.assign(patch, normaliseChannel(patch.slackChannelId, patch.slackChannelName));
  }

  if ('allowedPages' in patch) {
    let pages;
    try {
      pages = normalizeAllowedPages(patch.allowedPages);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // Postgres needs JSON text and Firestore needs a real array; the driver
    // layer handles that, but null has to survive as an explicit "no limits".
    patch.allowedPages = pages === undefined ? undefined : pages;
    if (patch.allowedPages === undefined) delete patch.allowedPages;
  }

  // An explicit password is hashed straight away -- the admin already knows it,
  // so nothing secret has to be parked anywhere.
  if (body.password) {
    // Held to the same policy as one somebody sets for themselves. An admin
    // typing a four-character password for a colleague is the same weakness as
    // the colleague typing it, and this is the path that used to allow it.
    const rejection = passwordPolicy.rejectionFor(body.password, {
      email: patch.email || before.email,
      name: patch.name || before.name,
    });
    if (rejection) return res.status(422).json({ error: rejection });
    Object.assign(patch, passwordPolicy.stampChange({ password: bcrypt.hashSync(body.password, 10) }));
  }

  // A *generated* password is different: on the approval path the value would
  // have to survive in the queue until somebody signs it off, and a plaintext
  // password sitting in a table is exactly what this codebase should not do.
  // So the intent travels and the queue mints the password at execution time,
  // emailing it to the account itself.
  const wantsGeneratedPassword = Boolean(body.regeneratePassword);
  let temporaryPassword;
  if (wantsGeneratedPassword && !roles.needsApproval(req.user)) {
    temporaryPassword = provisioning.generatePassword();
    Object.assign(patch, passwordPolicy.stampChange({ password: bcrypt.hashSync(temporaryPassword, 10) }));
  }

  // Who may touch the admin roster at all is a hard limit, separate from
  // whether this particular admin needs a second signature.
  const touchesAdminRoster = (patch.role && patch.role !== before.role)
    && (patch.role === 'admin' || before.role === 'admin');
  if (touchesAdminRoster && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can add or remove an administrator.' });
  }

  // The audit row names the fields an administrator actually chose to change.
  // The password and its age stamp are reported separately, as
  // `passwordRegenerated`, because listing three bookkeeping columns beside
  // "email" would bury the one that matters.
  const PASSWORD_INTERNALS = ['password', 'passwordChangedAt', 'passwordResetRequired', 'passwordResetAt'];
  const changedFields = Object.keys(patch).filter((k) => !PASSWORD_INTERNALS.includes(k));

  const gate = await approvals.gate(req, res, {
    action: 'user.update',
    summary: describeUserChange(before, patch, wantsGeneratedPassword),
    payload: {
      userId: req.params.id,
      patch,
      regeneratePassword: wantsGeneratedPassword,
      sendEmail: sendEmail !== false,
      requestedBy: req.user.name,
    },
  });
  if (gate.held) return;

  const updated = await db.update('users', req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'User not found' });

  const joinedChannel = patch.slackChannelId ? await provisioning.joinAssignedChannel(updated) : null;

  // Role or section access may have moved under this person's feet. Their open
  // tabs re-read who they are and redraw the navigation without a refresh.
  refreshSession(req.params.id);

  if (patch.password) {
    await db.removeWhere('sessions', (s) => s.userId === req.params.id);
  }

  // Backup codes only mean anything for an administrator, and a stale set on a
  // demoted account is a credential nobody is watching.
  if (patch.role && patch.role !== before.role && before.role === 'admin') {
    await recoveryCodes.clearFor(req.params.id);
  }

  // What changed, not merely that something did. An audit row reading
  // "update, user" with no detail is the difference between noticing an
  // account takeover and never knowing it happened. Field names only -- never
  // a password or a hash.
  await audit(req.user.id, 'update', 'user', req.params.id, {
    changed: changedFields,
    ...(patch.role && patch.role !== before.role ? { roleFrom: before.role, roleTo: patch.role } : {}),
    ...(temporaryPassword ? { passwordRegenerated: true } : {}),
    targetRole: before.role,
  });

  // A regenerated password is useless if the person never receives it. When it
  // is being withheld from the person doing the resetting, the email is the
  // only copy, so opting out of it is not offered -- that combination would set
  // a password nobody on earth knows.
  const mustEmail = before.role === 'admin' && before.id !== req.user.id;
  const emailed = temporaryPassword && (mustEmail || sendEmail !== false)
    ? await provisioning.emailCredentials(updated, temporaryPassword, { invitedBy: req.user.name, isReset: true, ipAddress: req.ip })
    : false;

  if (patch.role && patch.role !== before.role && (patch.role === 'admin' || before.role === 'admin')) {
    await announceRosterChange({
      actor: req.user,
      target: updated,
      change: patch.role === 'admin' ? 'added' : 'removed',
    });
  }

  // Handing the new password back on screen is how an admin passes credentials
  // to a client or a staff member in person, and that stays. It is not how one
  // administrator should come by another administrator's password: reset a
  // peer, read it off the response, sign in as them, and the log shows only a
  // routine password change. For that one case the password goes to the
  // owner's inbox and nowhere else -- the person resetting it never sees it.
  const targetIsPeerAdmin = before.role === 'admin' && !isSelf;
  const withholdPassword = Boolean(temporaryPassword) && targetIsPeerAdmin;

  res.json({
    user: { ...safeUser(updated), allowedPages: parseAllowedPages(updated.allowedPages) },
    ...(temporaryPassword && !withholdPassword
      ? { temporaryPassword, emailed, emailConfigured: mailer.isEnabled() }
      : {}),
    ...(withholdPassword
      ? {
        passwordSentToOwner: true,
        emailed,
        emailConfigured: mailer.isEnabled(),
        message: emailed
          ? `A new password was emailed to ${updated.email}. It is not shown here.`
          : `A new password was set but could not be emailed to ${updated.email}. They will need backup codes or a server-side reset.`,
      }
      : {}),
    ...(joinedChannel ? { slackChannel: joinedChannel } : {}),
  });
}));

router.delete('/:id', requireCSRF, requireRole('admin'), handleAdmin(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });

  const target = await db.find('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  await admins.assertRosterSurvives(req.params.id);

  if (target.role === 'admin' && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can remove an administrator.' });
  }
  // A super admin is never deleted out from under the workspace by someone
  // else; they step down first.
  if (roles.isSuperAdmin(target) && target.id !== req.user.id) {
    return res.status(403).json({ error: 'A super admin cannot be deleted. Step them down first.' });
  }

  const gate = await approvals.gate(req, res, {
    action: 'user.delete',
    summary: `Delete the ${target.role} account for ${target.name} (${target.email})`,
    payload: { userId: req.params.id },
  });
  if (gate.held) return;

  /**
   * One routine, shared with the approval queue.
   *
   * This used to do its own cleanup inline and the approval path did none, so
   * an account deleted through the queue -- which exists *because* the action
   * is sensitive -- kept its live sessions, and whoever held one stayed signed
   * in as a user who no longer existed. See utils/userErasure.js for what is
   * removed and what is deliberately kept.
   */
  const erased = await erasure.eraseUser(req.params.id);
  if (!erased) return res.status(404).json({ error: 'User not found' });

  // The counts, not just the fact. "Deleted an account" is a poor record of an
  // irreversible act; what was removed with it is what makes it a real one.
  await audit(req.user.id, 'delete', 'user', req.params.id, erased.removed);
  if (target.role === 'admin') {
    await announceRosterChange({ actor: req.user, target, change: 'removed' });
  }
  res.json({ ok: true });
}));

/**
 * Admin standing: who is a super admin, and who has been vouched for.
 *
 * Deliberately its own endpoint rather than fields on the ordinary update.
 * Promoting someone is not the same kind of act as fixing a typo in a name,
 * and it should not be possible to do one while meaning the other.
 */
/**
 * What this client is sent, and whether they are sent anything at all.
 *
 * The template list comes from utils/emailMessages.js rather than from a copy
 * kept here, so a message added to the app appears on this screen without
 * anybody remembering to add it. Only the ones a client actually reads are
 * offered: there is no sense asking whether a customer wants our own internal
 * approval notices.
 */
router.get('/:id/mail', requireRole('admin'), handleAdmin(async (req, res) => {
  const target = await db.find('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'client') {
    return res.status(400).json({ error: 'Only a client account has email settings.' });
  }

  const optOuts = clientMail.parseOptOuts(target.mailOptOuts);
  const groups = messages.listGroups()
    .map((group) => ({
      heading: group.heading,
      templates: group.templates
        .filter((t) => t.audience === 'client' || t.audience === 'both')
        .map((t) => ({ ...t, enabled: !optOuts.includes(t.key) })),
    }))
    .filter((group) => group.templates.length > 0);

  res.json({
    user: { id: target.id, name: target.name, email: target.email },
    mailEnabled: clientMail.isMailEnabled(target),
    // Whether they have ever been welcomed, so the screen can offer to do it
    // rather than leaving an admin wondering whether turning the switch on
    // sends anything by itself. It does not -- see the route below.
    welcomeEmailSentAt: target.welcomeEmailSentAt || null,
    optOuts,
    groups,
  });
}));

/**
 * Turn this client's email on or off, and pick which messages they get.
 *
 * Turning it on sends nothing by itself -- deliberately. A client muted since
 * March has months of held messages behind them, and releasing that backlog
 * the moment somebody pays would be a worse first impression than the silence
 * was. The switch only governs what happens from now on; the welcome is a
 * separate, deliberate press.
 */
router.put('/:id/mail', requireCSRF, requireRole('admin'), handleAdmin(async (req, res) => {
  const target = await db.find('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'client') {
    return res.status(400).json({ error: 'Only a client account has email settings.' });
  }

  const { mailEnabled, optOuts } = req.body || {};
  const patch = {};

  if (mailEnabled !== undefined) {
    if (typeof mailEnabled !== 'boolean') {
      return res.status(400).json({ error: 'mailEnabled must be true or false.' });
    }
    patch.mailEnabled = mailEnabled;
  }

  if (optOuts !== undefined) {
    let clean;
    try {
      clean = clientMail.normalizeOptOuts(optOuts);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    patch.mailOptOuts = JSON.stringify(clean);
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change' });

  const updated = await db.update('users', target.id, patch);
  await audit(req.user.id, 'update', 'user', target.id, {
    mailEnabled: patch.mailEnabled,
    ...(patch.mailOptOuts ? { optOuts: JSON.parse(patch.mailOptOuts) } : {}),
  });

  res.json({
    mailEnabled: clientMail.isMailEnabled(updated),
    optOuts: clientMail.parseOptOuts(updated.mailOptOuts),
  });
}));

/**
 * Send the welcome email now, on purpose.
 *
 * The one message that has to be sendable by hand. Every other message in the
 * app is triggered by something happening -- a payment, a ticket, a launch --
 * so once a client's email is on, those arrive on their own. The welcome is
 * triggered by the account being created, which for these clients happened
 * months before they agreed to anything.
 */
router.post('/:id/welcome', requireCSRF, requireRole('admin'), handleAdmin(async (req, res) => {
  const target = await db.find('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'client') {
    return res.status(400).json({ error: 'Only a client gets the welcome email.' });
  }
  if (!clientMail.isMailEnabled(target)) {
    return res.status(409).json({
      error: 'This client is not being emailed yet. Turn their email on first.',
    });
  }
  if (target.welcomeEmailSentAt) {
    return res.status(409).json({
      error: `They were already welcomed on ${String(target.welcomeEmailSentAt).slice(0, 10)}.`,
    });
  }

  const sent = await require('../utils/subscriptions').sendWelcome(target, { reason: 'signup' });
  if (!sent) {
    return res.status(502).json({ error: 'The welcome email could not be sent. Check the Mail page for why.' });
  }
  await audit(req.user.id, 'update', 'user', target.id, { welcomeEmail: 'sent' });
  res.json({ ok: true });
}));

router.post('/:id/standing', requireCSRF, requireRole('admin'), sensitiveAdminLimiter, handleAdmin(async (req, res) => {
  if (!roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can change admin standing.' });
  }

  const target = await db.find('users', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'admin') {
    return res.status(400).json({ error: 'Only an administrator has standing to change.' });
  }

  const { superAdmin, trusted } = req.body || {};
  const patch = {};

  if (superAdmin !== undefined) {
    if (superAdmin === false && roles.isSuperAdmin(target)) {
      const remaining = (await roles.listSuperAdmins()).filter((u) => u.id !== target.id);
      if (remaining.length === 0) {
        return res.status(409).json({
          error: 'This is the only super admin. Appoint another one before stepping this one down.',
        });
      }
    }
    patch.isSuperAdmin = Boolean(superAdmin);
    // A super admin is trusted by definition; there is nobody above them to
    // countersign, so holding their changes would deadlock the workspace.
    if (patch.isSuperAdmin) patch.adminTrusted = true;
  }

  if (trusted !== undefined) {
    if (roles.isSuperAdmin(target) && trusted === false && patch.isSuperAdmin !== false) {
      return res.status(400).json({ error: 'A super admin is always trusted.' });
    }
    patch.adminTrusted = Boolean(trusted);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to change' });
  }

  if (patch.adminTrusted) {
    patch.adminTrustedAt = new Date().toISOString();
    patch.adminTrustedBy = req.user.id;
  } else if (patch.adminTrusted === false) {
    patch.adminTrustedAt = null;
    patch.adminTrustedBy = null;
  }

  const updated = await db.update('users', req.params.id, patch);
  await audit(req.user.id, 'standing', 'user', req.params.id, patch);
  refreshSession(req.params.id);

  const what = [
    patch.isSuperAdmin === true ? 'made a super admin' : null,
    patch.isSuperAdmin === false ? 'stepped down from super admin' : null,
    patch.isSuperAdmin === undefined && patch.adminTrusted === true ? 'trusted to act without approval' : null,
    patch.isSuperAdmin === undefined && patch.adminTrusted === false ? 'moved back to needing approval' : null,
  ].filter(Boolean).join(' and ');
  await notify(req.params.id, `${req.user.name} ${what} you.`, 'general');
  await admins.notifyAdmins(`${updated.name} was ${what} by ${req.user.name}.`, 'general', { exceptUserId: req.user.id });

  res.json({ user: safeUser(updated) });
}));

/**
 * The Slack channel a client is tied to.
 *
 * Slack ids look like C0123ABCD (public), G… (private), or D… (a DM). A DM is
 * refused: it is one person's inbox, not a room the team shares. Clearing it is
 * allowed and simply takes the Messages page away from them.
 */
function normaliseChannel(id, name) {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (!raw) return { slackChannelId: null, slackChannelName: null };
  if (!/^[CG][A-Z0-9]{5,}$/i.test(raw)) {
    throw new admins.AdminError('That does not look like a Slack channel id. Pick the channel from the list.', 400);
  }
  return {
    slackChannelId: raw.toUpperCase(),
    slackChannelName: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : null,
  };
}

/**
 * A one-line description of what an update actually changes, for the queue.
 *
 * The approver reads this sentence and nothing else before clicking. It used
 * to describe only the fields it happened to know about, so anything it did
 * not recognise was summarised as "their details" -- which is how a promotion
 * came to be presented as a name change. Every field in the patch is now
 * named, and anything unrecognised is listed raw rather than swallowed.
 */
function describeUserChange(before, patch, passwordRegenerated) {
  const described = new Set();
  const parts = [];
  const say = (field, text) => { described.add(field); if (text) parts.push(text); };

  say('role', patch.role && patch.role !== before.role ? `their role from ${before.role} to ${patch.role}` : null);
  say('allowedPages', 'allowedPages' in patch ? 'which sections they can open' : null);
  say('name', patch.name && patch.name !== before.name ? `their name to "${patch.name}"` : null);
  say('email', patch.email && patch.email !== before.email ? `their email to ${patch.email}` : null);
  say('company', 'company' in patch && patch.company !== before.company ? 'their company' : null);
  say('passwordExpiresAt', 'passwordExpiresAt' in patch ? 'when their access expires' : null);
  say('slackChannelId', 'slackChannelId' in patch ? 'their Slack channel' : null);
  say('slackChannelName', null);
  say('password', passwordRegenerated ? 'a new password' : null);

  // Anything this function has not been taught about is still shown, by name.
  // Silence here is exactly what made the queue misleading.
  for (const key of Object.keys(patch)) {
    if (!described.has(key)) parts.push(`${key}`);
  }

  const what = parts.length > 0 ? parts.join(', ') : 'nothing';
  return `Change ${what} for ${before.name} (${before.email})`;
}

module.exports = router;
