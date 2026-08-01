'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, safeUser, audit } = require('../middleware/auth');

router.use(requireAuth);

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
    const { name, email, password } = req.body || {};
    const patch = {};
    if (name) patch.name = name;
    if (email) patch.email = email;
    if (password) patch.password = bcrypt.hashSync(password, 10);

    const updated = await db.update('users', req.user.id, patch);
    await audit(req.user.id, 'update', 'user', req.user.id, { self: true });
    res.json({ user: safeUser(updated) });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const users = await db.all('users');
    if (req.user.role === 'admin') {
      return res.json({ users: users.map(safeUser) });
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
    const { name, email, role, company, password, passwordExpiresAt } = req.body || {};
    if (!name || !email || !role) return res.status(400).json({ error: 'name, email, and role are required' });
    const validRoles = ['admin', 'sales', 'project_manager', 'employee', 'client'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (passwordExpiresAt !== undefined && passwordExpiresAt !== null && !Number.isFinite(Number(passwordExpiresAt))) {
      return res.status(400).json({ error: 'passwordExpiresAt must be a timestamp or null' });
    }

    const existing = await db.filter('users', (u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing.length > 0) return res.status(409).json({ error: 'A user with that email already exists' });

    const plaintextPassword = password || generatePassword();
    const user = await db.insert('users', {
      name, email, role, company: company || null, password: bcrypt.hashSync(plaintextPassword, 10),
      passwordExpiresAt: passwordExpiresAt != null ? Number(passwordExpiresAt) : null,
    });
    await audit(req.user.id, 'create', 'user', user.id);
    res.status(201).json({ user: safeUser(user), temporaryPassword: plaintextPassword });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const patch = { ...req.body };
    delete patch.id;

    if (patch.passwordExpiresAt !== undefined && patch.passwordExpiresAt !== null && !Number.isFinite(Number(patch.passwordExpiresAt))) {
      return res.status(400).json({ error: 'passwordExpiresAt must be a timestamp or null' });
    }
    if (patch.passwordExpiresAt != null) patch.passwordExpiresAt = Number(patch.passwordExpiresAt);

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

    const updated = await db.update('users', req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    if (patch.password) {
      await db.removeWhere('sessions', (s) => s.userId === req.params.id);
    }

    await audit(req.user.id, 'update', 'user', req.params.id, temporaryPassword ? { passwordRegenerated: true } : undefined);
    res.json({ user: safeUser(updated), ...(temporaryPassword ? { temporaryPassword } : {}) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
    const ok = await db.remove('users', req.params.id);
    if (!ok) return res.status(404).json({ error: 'User not found' });

    await db.removeWhere('sessions', (s) => s.userId === req.params.id);
    await db.removeWhere('otp_codes', (o) => o.userId === req.params.id);

    const tasks = await db.filter('tasks', (t) => t.assigneeId === req.params.id);
    for (const t of tasks) await db.update('tasks', t.id, { assigneeId: null });
    const tickets = await db.filter('tickets', (t) => t.assigneeId === req.params.id);
    for (const t of tickets) await db.update('tickets', t.id, { assigneeId: null });

    await audit(req.user.id, 'delete', 'user', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
