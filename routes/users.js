'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, safeUser, audit } = require('../middleware/auth');

router.use(requireAuth);

const { isFirebaseAdminConfigured, verifyFirebaseIdToken } = require('../utils/firebaseAdmin');

// Enable 2FA -- requires proving control of the phone/email first via a
// Firebase-verified ID token, so you can't lock someone else's account.
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

// Self-service profile update — must come before the admin-only /:id route.
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
    const { name, email, role, company, password } = req.body || {};
    if (!name || !email || !role || !password) return res.status(400).json({ error: 'name, email, role, and password are required' });
    const validRoles = ['admin', 'sales', 'project_manager', 'employee', 'client'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const existing = await db.filter('users', (u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing.length > 0) return res.status(409).json({ error: 'A user with that email already exists' });

    const user = await db.insert('users', {
      name, email, role, company: company || null, password: bcrypt.hashSync(password, 10),
    });
    await audit(req.user.id, 'create', 'user', user.id);
    res.status(201).json({ user: safeUser(user) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const patch = { ...req.body };
    delete patch.id;
    if (patch.password) patch.password = bcrypt.hashSync(patch.password, 10);
    else delete patch.password;

    const updated = await db.update('users', req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    await audit(req.user.id, 'update', 'user', req.params.id);
    res.json({ user: safeUser(updated) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
    const ok = await db.remove('users', req.params.id);
    if (!ok) return res.status(404).json({ error: 'User not found' });

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
