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

/** Human labels for the sections a login can open, for the welcome email. */
function sectionLabels(user) {
  const keys = allowedPagesFor(user);
  return CLIENT_PAGES.filter((p) => keys.includes(p.key)).map((p) => p.label);
}

/**
 * Email someone the credentials an admin just issued them. Best-effort: an
 * unreachable inbox must not fail the account creation, and the admin still
 * sees the password on screen either way.
 */
async function emailCredentials(user, temporaryPassword, { invitedBy, isReset = false, ipAddress = null }) {
  // Clients get a one-tap link in the same email, so the first sign-in costs
  // no typing on a phone. Staff do not: their accounts can change other
  // people's access, which a link in an inbox is not a strong enough gate for.
  // Best-effort -- a link that cannot be minted must not stop the credentials
  // going out.
  let signInUrl = null;
  if (user.role === 'client' && baseUrl()) {
    try {
      const { path } = await loginLinks.issueFor(user, { ipAddress, ttlMs: loginLinks.WELCOME_TOKEN_TTL_MS });
      signInUrl = `${baseUrl()}${path}`;
    } catch (err) {
      console.error('Could not mint the welcome sign-in link:', err.message);
    }
  }

  const result = await mailer.sendTemplate({
    to: user.email,
    message: messages.credentialsIssued({
      user,
      temporaryPassword,
      expiresAt: user.passwordExpiresAt || null,
      sections: user.role === 'client' ? sectionLabels(user) : null,
      invitedBy,
      isReset,
      signInUrl,
    }),
    template: 'credentials',
    entity: 'user',
    entityId: user.id,
  });
  return Boolean(result.ok);
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

const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generatePassword(length = 14) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
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

router.get('/', async (req, res, next) => {
  try {
    const users = await db.all('users');
    if (req.user.role === 'admin') {
      return res.json({
        users: users.map((u) => ({ ...safeUser(u), allowedPages: parseAllowedPages(u.allowedPages) })),
      });
    }
    const directory = users
      .filter((u) => u.role !== 'client' || u.id === req.user.id)
      .map((u) => ({ id: u.id, name: u.name, role: u.role, company: u.company || null }));
    res.json({ users: directory });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin'), async (req, res, next) => {
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

    const plaintextPassword = password || generatePassword();

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

    const user = await db.insert('users', {
      name, email, role, company: company || null, password: bcrypt.hashSync(plaintextPassword, 10),
      passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
      allowedPages: pages === undefined ? null : pages,
      // Only a client has a channel; staff reach all of Slack through the
      // integrations page anyway.
      ...(role === 'client' ? normaliseChannel(slackChannelId, slackChannelName) : {}),
    });
    await audit(req.user.id, 'create', 'user', user.id, pages ? { allowedPages: pages } : undefined);

    // Get the bot into the channel now, while an admin is here to read the
    // answer, rather than at the moment the client first opens Messages.
    const joined = await joinAssignedChannel(user);

    // Default to emailing the credentials; an admin can opt out and hand them
    // over in person instead.
    const emailed = sendEmail === false
      ? false
      : await emailCredentials(user, plaintextPassword, { invitedBy: req.user.name, ipAddress: req.ip });

    if (role === 'admin') await announceRosterChange({ actor: req.user, target: user, change: 'added' });

    res.status(201).json({
      user: { ...safeUser(user), allowedPages: parseAllowedPages(user.allowedPages) },
      temporaryPassword: plaintextPassword,
      emailed,
      emailConfigured: mailer.isEnabled(),
      ...(joined ? { slackChannel: joined } : {}),
    });
  } catch (err) {
    if (err instanceof admins.AdminError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/:id', requireCSRF, requireRole('admin'), handleAdmin(async (req, res) => {
  const patch = { ...req.body };
  delete patch.id;
  const sendEmail = patch.sendEmail;
  delete patch.sendEmail;

  const before = await db.find('users', req.params.id);
  if (!before) return res.status(404).json({ error: 'User not found' });

  // Moving the last administrator off the admin role would lock the whole
  // workspace out of user management.
  if (patch.role && patch.role !== before.role) {
    await admins.assertRosterSurvives(req.params.id, { nextRole: patch.role });
  }

  if (patch.passwordExpiresAt !== undefined && patch.passwordExpiresAt !== null && !Number.isFinite(Number(patch.passwordExpiresAt))) {
    return res.status(400).json({ error: 'passwordExpiresAt must be a timestamp or null' });
  }
  if (patch.passwordExpiresAt != null) patch.passwordExpiresAt = Number(patch.passwordExpiresAt);

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

  let temporaryPassword;
  if (patch.regeneratePassword) {
    temporaryPassword = generatePassword();
    patch.password = bcrypt.hashSync(temporaryPassword, 10);
  } else if (patch.password) {
    patch.password = bcrypt.hashSync(patch.password, 10);
  } else {
    delete patch.password;
  }
  delete patch.regeneratePassword;

  // Two separate rules on the same call. Who may touch the admin roster at all
  // is a hard limit; whether this particular admin needs a second signature is
  // the softer one below it.
  const touchesAdminRoster = (patch.role && patch.role !== before.role)
    && (patch.role === 'admin' || before.role === 'admin');
  if (touchesAdminRoster && !roles.canManageAdmins(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can add or remove an administrator.' });
  }
  if ('isSuperAdmin' in patch || 'adminTrusted' in patch) {
    return res.status(400).json({ error: 'Use the super-admin endpoints to change admin standing.' });
  }

  const gate = await approvals.gate(req, res, {
    action: 'user.update',
    summary: describeUserChange(before, patch, temporaryPassword != null),
    payload: { userId: req.params.id, patch },
  });
  if (gate.held) return;

  const updated = await db.update('users', req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'User not found' });

  const joinedChannel = patch.slackChannelId ? await joinAssignedChannel(updated) : null;

  // Role or section access may have moved under this person's feet. Their open
  // tabs re-read who they are and redraw the navigation without a refresh.
  refreshSession(req.params.id);

  if (patch.password) {
    await db.removeWhere('sessions', (s) => s.userId === req.params.id);
  }

  await audit(req.user.id, 'update', 'user', req.params.id, temporaryPassword ? { passwordRegenerated: true } : undefined);

  // A regenerated password is useless if the person never receives it.
  const emailed = temporaryPassword && sendEmail !== false
    ? await emailCredentials(updated, temporaryPassword, { invitedBy: req.user.name, isReset: true, ipAddress: req.ip })
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
router.post('/:id/standing', requireCSRF, requireRole('admin'), handleAdmin(async (req, res) => {
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
 * Add the bot to a client's channel as soon as one is chosen.
 *
 * A public channel it can join itself; a private one needs an invite from
 * somebody already in it. Either way the answer comes back now, to the admin
 * who just made the choice, instead of surfacing later as an empty page the
 * client cannot explain. Best-effort: Slack being down must not fail the
 * account change that already succeeded.
 */
async function joinAssignedChannel(user) {
  if (!user?.slackChannelId) return null;
  const slack = require('../utils/slack');
  if (!slack.isEnabled()) {
    return { joined: false, message: 'Slack is not connected, so the bot could not be added yet.' };
  }
  try {
    const result = await slack.joinChannel(user.slackChannelId);
    return result.joined
      ? { joined: true }
      : { joined: false, message: result.message || 'The bot could not add itself to that channel.' };
  } catch (err) {
    return { joined: false, message: err.message };
  }
}

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

/** A one-line description of what an update actually changes, for the queue. */
function describeUserChange(before, patch, passwordRegenerated) {
  const parts = [];
  if (patch.role && patch.role !== before.role) parts.push(`role to ${patch.role}`);
  if ('allowedPages' in patch) parts.push('which sections they can open');
  if (patch.name && patch.name !== before.name) parts.push('their name');
  if (patch.email && patch.email !== before.email) parts.push(`their email to ${patch.email}`);
  if ('passwordExpiresAt' in patch) parts.push('when their access expires');
  if (passwordRegenerated) parts.push('a new password');
  const what = parts.length > 0 ? parts.join(', ') : 'their details';
  return `Change ${what} for ${before.name} (${before.email})`;
}

module.exports = router;
