'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, safeUser, audit, notify, refreshSession } = require('../middleware/auth');
const roles = require('../utils/roles');
const approvals = require('../utils/approvals');
const { CLIENT_PAGES, normalizeAllowedPages, parseAllowedPages, allowedPagesFor } = require('../utils/clientPages');
const mailer = require('../utils/mailer');
const messages = require('../utils/emailMessages');
const admins = require('../utils/admins');
const loginLinks = require('../utils/loginLinks');
const userFields = require('../utils/userFields');
const provisioning = require('../utils/userProvisioning');
const { sensitiveAdminLimiter, credentialIssueLimiter, recoveryCodeLimiter } = require('../utils/rateLimits');
const recoveryCodes = require('../utils/recoveryCodes');
const { baseUrl } = require('../utils/appUrl');

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

router.post('/me/2fa/disable', requireCSRF, async (req, res, next) => {
  try {
    const updated = await db.update('users', req.user.id, { twoFactorEnabled: false, twoFactorContact: null });
    await audit(req.user.id, 'update', 'user', req.user.id, { action: '2fa_disabled' });
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

router.put('/me', requireCSRF, async (req, res, next) => {
  try {
    const { name, email, password, currentPassword } = req.body || {};
    const patch = {};
    if (name) patch.name = name;

    // Changing the email must not collide with another account, or that
    // account could no longer sign in.
    if (email && email.toLowerCase() !== req.user.email.toLowerCase()) {
      const taken = await db.filter(
        'users',
        (u) => u.id !== req.user.id && u.email.toLowerCase() === email.toLowerCase(),
      );
      if (taken.length > 0) return res.status(409).json({ error: 'That email is already in use' });
      patch.email = email;
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
      patch.password = bcrypt.hashSync(password, 10);
    }

    const updated = await db.update('users', req.user.id, patch);

    // Any other session of this user dies with the old password.
    if (patch.password) {
      await db.removeWhere('sessions', (s) => s.userId === req.user.id && s.id !== req.session.id);
    }

    await audit(req.user.id, 'update', 'user', req.user.id, { self: true, passwordChanged: Boolean(patch.password) });
    res.json({ user: safeUser(updated) });
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
      return res.json({
        users: users.map((u) => ({ ...safeUser(u), allowedPages: parseAllowedPages(u.allowedPages) })),
      });
    }

    if (req.user.role === 'client') {
      // Whoever this client can already see the work of: the manager on their
      // projects, and the person handling each of their tickets. Names, so the
      // portal can say who replied -- never the role, so the roster stays shut.
      const [projects, tickets] = await Promise.all([db.all('projects'), db.all('tickets')]);
      const connected = new Set();
      for (const p of projects) {
        if (p.clientId === req.user.id && p.assignedPmId) connected.add(p.assignedPmId);
      }
      for (const t of tickets) {
        if (t.clientId === req.user.id && t.assigneeId) connected.add(t.assigneeId);
      }

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
      name, email, role, company, password, passwordExpiresAt, allowedPages, sendEmail,
      slackChannelId, slackChannelName,
    } = req.body || {};
    if (!name || !email || !role) return res.status(400).json({ error: 'name, email, and role are required' });
    const validRoles = ['admin', 'sales', 'project_manager', 'employee', 'client'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (passwordExpiresAt !== undefined && passwordExpiresAt !== null && !Number.isFinite(Number(passwordExpiresAt))) {
      return res.status(400).json({ error: 'passwordExpiresAt must be a timestamp or null' });
    }

    const existing = await db.filter('users', (u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing.length > 0) return res.status(409).json({ error: 'A user with that email already exists' });

    // Appointing an administrator is the one thing an ordinary admin cannot do
    // at all, approval or not. Only a super admin grows the admin roster.
    if (role === 'admin' && !roles.canManageAdmins(req.user)) {
      return res.status(403).json({ error: 'Only a super admin can create an administrator.' });
    }

    // Page toggles only mean anything for clients; staff always see their whole role.
    const pages = role === 'client' ? normalizeAllowedPages(allowedPages) : null;

    const plaintextPassword = password || provisioning.generatePassword();

    // An admin nobody has vouched for yet proposes; somebody else releases it.
    const gate = await approvals.gate(req, res, {
      action: 'user.create',
      summary: `Create a ${role} account for ${name} (${email})`,
      payload: {
        name, email, role, company: company || null, plaintextPassword,
        passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
        allowedPages: pages === undefined ? null : pages,
        ...(role === 'client' ? normaliseChannel(slackChannelId, slackChannelName) : {}),
      },
    });
    if (gate.held) return;

    const user = await provisioning.createUserRecord({
      name, email, role, company: company || null, plaintextPassword,
      passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
      allowedPages: pages === undefined ? null : pages,
      ...(role === 'client' ? normaliseChannel(slackChannelId, slackChannelName) : {}),
    });
    await audit(req.user.id, 'create', 'user', user.id, {
      role,
      ...(pages ? { allowedPages: pages } : {}),
    });

    // Get the bot into the channel now, while an admin is here to read the
    // answer, rather than at the moment the client first opens Messages.
    const joined = await provisioning.joinAssignedChannel(user);

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

  // Taking an address another account already uses would lock that account
  // out. The self-service profile screen has always said so; this one used to
  // let the database raise it as a 500 instead.
  if (patch.email && String(patch.email).toLowerCase() !== String(before.email).toLowerCase()) {
    const taken = await db.filter(
      'users',
      (u) => u.id !== req.params.id && String(u.email).toLowerCase() === String(patch.email).toLowerCase(),
    );
    if (taken.length > 0) return res.status(409).json({ error: 'That email is already in use' });
  }

  if ('slackChannelId' in patch || 'slackChannelName' in patch) {
    Object.assign(patch, normaliseChannel(patch.slackChannelId, patch.slackChannelName));
  }

  if ('allowedPages' in patch) {
    const pages = normalizeAllowedPages(patch.allowedPages);
    // Postgres needs JSON text and Firestore needs a real array; the driver
    // layer handles that, but null has to survive as an explicit "no limits".
    patch.allowedPages = pages === undefined ? undefined : pages;
    if (patch.allowedPages === undefined) delete patch.allowedPages;
  }

  // An explicit password is hashed straight away -- the admin already knows it,
  // so nothing secret has to be parked anywhere.
  if (body.password) patch.password = bcrypt.hashSync(body.password, 10);

  // A *generated* password is different: on the approval path the value would
  // have to survive in the queue until somebody signs it off, and a plaintext
  // password sitting in a table is exactly what this codebase should not do.
  // So the intent travels and the queue mints the password at execution time,
  // emailing it to the account itself.
  const wantsGeneratedPassword = Boolean(body.regeneratePassword);
  let temporaryPassword;
  if (wantsGeneratedPassword && !roles.needsApproval(req.user)) {
    temporaryPassword = provisioning.generatePassword();
    patch.password = bcrypt.hashSync(temporaryPassword, 10);
  }

  // Who may touch the admin roster at all is a hard limit, separate from
  // whether this particular admin needs a second signature.
  const touchesAdminRoster = (patch.role && patch.role !== before.role)
    && (patch.role === 'admin' || before.role === 'admin');
  if (touchesAdminRoster && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can add or remove an administrator.' });
  }

  const changedFields = Object.keys(patch).filter((k) => k !== 'password');

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

  // A regenerated password is useless if the person never receives it.
  const emailed = temporaryPassword && sendEmail !== false
    ? await provisioning.emailCredentials(updated, temporaryPassword, { invitedBy: req.user.name, isReset: true, ipAddress: req.ip })
    : false;

  if (patch.role && patch.role !== before.role && (patch.role === 'admin' || before.role === 'admin')) {
    await announceRosterChange({
      actor: req.user,
      target: updated,
      change: patch.role === 'admin' ? 'added' : 'removed',
    });
  }

  res.json({
    user: { ...safeUser(updated), allowedPages: parseAllowedPages(updated.allowedPages) },
    ...(temporaryPassword ? { temporaryPassword, emailed, emailConfigured: mailer.isEnabled() } : {}),
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

  const ok = await db.remove('users', req.params.id);
  if (!ok) return res.status(404).json({ error: 'User not found' });

  await db.removeWhere('sessions', (s) => s.userId === req.params.id);
  await db.removeWhere('otp_codes', (o) => o.userId === req.params.id);
  await recoveryCodes.clearFor(req.params.id);

  const tasks = await db.filter('tasks', (t) => t.assigneeId === req.params.id);
  for (const t of tasks) await db.update('tasks', t.id, { assigneeId: null });
  const tickets = await db.filter('tickets', (t) => t.assigneeId === req.params.id);
  for (const t of tickets) await db.update('tickets', t.id, { assigneeId: null });

  await audit(req.user.id, 'delete', 'user', req.params.id);
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
