'use strict';

/**
 * The second-signature queue, and the super admin's window on it.
 *
 * Every administrator can see the queue -- an untrusted admin needs to watch
 * their own proposals, and a trusted one needs to act on other people's. Only
 * a trusted admin or a super admin can decide, and nobody decides their own.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
const approvals = require('../utils/approvals');
const roles = require('../utils/roles');

router.use(requireAuth, requireRole('admin'));

function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof approvals.ApprovalError) {
        return res.status(err.status).json({ error: err.message, request: err.request || null });
      }
      next(err);
    }
  };
}

router.get('/', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const requests = await approvals.list({ status });
  res.json({
    requests,
    pending: requests.filter((r) => r.status === 'pending').length,
    capabilities: roles.capabilitiesFor(req.user),
  });
}));

router.post('/:id/approve', requireCSRF, handle(async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  const { request, result } = await approvals.decide(req.params.id, req.user, 'approved', note);
  await audit(req.user.id, 'approve', 'approval_request', req.params.id, { action: request.action });
  res.json({ request: approvals.publicRequest(request), result: result ? true : null });
}));

router.post('/:id/reject', requireCSRF, handle(async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  const { request } = await approvals.decide(req.params.id, req.user, 'rejected', note);
  await audit(req.user.id, 'reject', 'approval_request', req.params.id, { action: request.action });
  res.json({ request: approvals.publicRequest(request) });
}));

router.post('/:id/cancel', requireCSRF, handle(async (req, res) => {
  const request = await approvals.cancel(req.params.id, req.user);
  await audit(req.user.id, 'cancel', 'approval_request', req.params.id);
  res.json({ request: approvals.publicRequest(request) });
}));

/**
 * The log.
 *
 * A super admin can read what everyone did, including the other admins, which
 * is the point of there being a super admin at all. Names are resolved here so
 * the page never has to hold a copy of the user directory to read a row.
 */
router.get('/audit-log', handle(async (req, res) => {
  if (!roles.canReadAuditLog(req.user)) {
    return res.status(403).json({ error: 'Only a super admin can read the audit log' });
  }

  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const [rows, users] = await Promise.all([db.all('activity_log'), db.all('users')]);
  const byId = new Map(users.map((u) => [u.id, u]));

  const entries = rows
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((row) => {
      const actor = byId.get(row.actorId);
      return {
        id: row.id,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        meta: typeof row.meta === 'string' ? safeJson(row.meta) : row.meta || null,
        createdAt: row.createdAt,
        actorId: row.actorId,
        actorName: actor?.name || (row.actorId ? 'Removed account' : 'System'),
        actorRole: actor?.role || null,
        actorIsSuperAdmin: actor ? roles.isSuperAdmin(actor) : false,
        // Whether this actor has a picture, and the stamp that versions its
        // URL. Sent so the log can draw faces without asking for one per row
        // and collecting a 404 for everybody who has not uploaded anything.
        actorAvatarUpdatedAt: actor?.avatarUpdatedAt ? Number(actor.avatarUpdatedAt) : null,
      };
    });

  res.json({ entries, total: rows.length });
}));

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

module.exports = router;
