'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, safeUser, audit } = require('../middleware/auth');

router.use(requireAuth);

// Self-service profile update — must come before the admin-only /:id route.
router.put('/me', requireCSRF, (req, res) => {
  const { name, email, password } = req.body || {};
  const patch = {};
  if (name) patch.name = name;
  if (email) patch.email = email;
  if (password) patch.password = bcrypt.hashSync(password, 10);

  const updated = db.update('users', req.user.id, patch);
  audit(req.user.id, 'update', 'user', req.user.id, { self: true });
  res.json({ user: safeUser(updated) });
});

// Everyone signed in can see a lightweight directory (for assignment dropdowns),
// but only Admin gets full user management data.
router.get('/', (req, res) => {
  const users = db.all('users');
  if (req.user.role === 'admin') {
    return res.json({ users: users.map(safeUser) });
  }
  const directory = users
    .filter((u) => u.role !== 'client' || u.id === req.user.id)
    .map((u) => ({ id: u.id, name: u.name, role: u.role, company: u.company || null }));
  res.json({ users: directory });
});

router.post('/', requireCSRF, requireRole('admin'), (req, res) => {
  const { name, email, role, company, password } = req.body || {};
  if (!name || !email || !role || !password) return res.status(400).json({ error: 'name, email, role, and password are required' });
  const validRoles = ['admin', 'sales', 'project_manager', 'employee', 'client'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.filter('users', (u) => u.email.toLowerCase() === email.toLowerCase()).length > 0) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  const user = db.insert('users', {
    name, email, role, company: company || null, password: bcrypt.hashSync(password, 10),
  });
  audit(req.user.id, 'create', 'user', user.id);
  res.status(201).json({ user: safeUser(user) });
});

router.put('/:id', requireCSRF, requireRole('admin'), (req, res) => {
  const patch = { ...req.body };
  delete patch.id;
  if (patch.password) patch.password = bcrypt.hashSync(patch.password, 10);
  else delete patch.password;

  const updated = db.update('users', req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'User not found' });
  audit(req.user.id, 'update', 'user', req.params.id);
  res.json({ user: safeUser(updated) });
});

router.delete('/:id', requireCSRF, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  const ok = db.remove('users', req.params.id);
  if (!ok) return res.status(404).json({ error: 'User not found' });

  // Unassign, don't cascade-delete, anything that referenced this user.
  db.all('tasks').forEach((t) => { if (t.assigneeId === req.params.id) db.update('tasks', t.id, { assigneeId: null }); });
  db.all('tickets').forEach((t) => { if (t.assigneeId === req.params.id) db.update('tickets', t.id, { assigneeId: null }); });

  audit(req.user.id, 'delete', 'user', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
