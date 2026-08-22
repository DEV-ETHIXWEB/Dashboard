'use strict';

/**
 * A second signature on the changes that are hard to undo.
 *
 * An administrator who has not been vouched for can still *propose* anything
 * their role allows. The proposal is written down, every approver is told, and
 * nothing happens to the data until someone entitled to sign it off does. The
 * proposer cannot sign their own.
 *
 * Two rules make this trustworthy rather than decorative:
 *
 *   1. The check lives on the server, in the route, before the write. The
 *      browser hiding a button is a courtesy; this is the control.
 *   2. Every action is a named entry in ACTIONS below with one `execute`.
 *      The stored payload is the only input it gets, so what was approved is
 *      exactly what runs -- a proposal cannot be edited into something else
 *      between the request and the signature.
 *
 * Execution happens once. `status` moves pending -> approved and the row is
 * stamped `executed_at` in the same pass; a second approval of the same row is
 * refused rather than replayed.
 */

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const { db } = require('../db/setup');
const roles = require('./roles');
const live = require('./liveBus');

/** A proposal nobody looked at goes stale rather than lurking forever. */
const TTL_MS = 48 * 60 * 60 * 1000;

class ApprovalError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
  }
}

// --- the catalogue ---------------------------------------------------------

/**
 * Everything an untrusted admin can propose but not do alone.
 *
 * `execute` receives the payload exactly as it was stored and the actor who
 * proposed it, so the audit trail names the right person even though a
 * different person released it.
 */
const ACTIONS = {
  'user.create': {
    label: 'Create an account',
    async execute(payload) {
      const existing = await db.filter('users', (u) => u.email.toLowerCase() === String(payload.email).toLowerCase());
      if (existing.length > 0) throw new ApprovalError('A user with that email already exists', 409);

      return db.insert('users', {
        name: payload.name,
        email: payload.email,
        role: payload.role,
        company: payload.company || null,
        password: bcrypt.hashSync(payload.plaintextPassword, 10),
        passwordExpiresAt: payload.passwordExpiresAt != null ? Number(payload.passwordExpiresAt) : null,
        allowedPages: payload.allowedPages === undefined ? null : payload.allowedPages,
      });
    },
  },

  'user.update': {
    label: 'Change an account',
    async execute(payload) {
      const target = await db.find('users', payload.userId);
      if (!target) throw new ApprovalError('That account no longer exists', 404);
      return db.update('users', payload.userId, payload.patch);
    },
  },

  'user.delete': {
    label: 'Delete an account',
    async execute(payload) {
      const target = await db.find('users', payload.userId);
      if (!target) throw new ApprovalError('That account no longer exists', 404);
      await db.remove('users', payload.userId);
      return target;
    },
  },

  'project.delete': {
    label: 'Delete a project',
    async execute(payload) {
      const removedTasks = await db.removeWhere('tasks', (t) => t.projectId === payload.projectId);
      await db.remove('projects', payload.projectId);
      return { removedTasks };
    },
  },

  'domain.delete': {
    label: 'Delete a website address',
    async execute(payload) {
      const ok = await db.remove('domains', payload.domainId);
      if (!ok) throw new ApprovalError('That domain no longer exists', 404);
      return { ok };
    },
  },

  'report.delete': {
    label: 'Delete a document',
    async execute(payload) {
      const ok = await db.remove('reports', payload.reportId);
      if (!ok) throw new ApprovalError('That document no longer exists', 404);
      return { ok };
    },
  },

  'ticket.close': {
    label: 'Close a ticket',
    async execute(payload, ctx) {
      const ticketStatus = require('./ticketStatus');
      // The client reads "Ryan closed your ticket", not the name of whoever
      // countersigned it, so the announcement is made as the proposer.
      const proposer = (await db.find('users', ctx?.requestedBy)) || { name: 'The team' };
      return ticketStatus.applyStatusChange({
        ticketId: payload.ticketId,
        toStatus: payload.toStatus,
        actor: proposer,
        patch: payload.patch || {},
      });
    },
  },

  'ticket.delete': {
    label: 'Delete a ticket',
    async execute(payload) {
      const ok = await db.remove('tickets', payload.ticketId);
      if (!ok) throw new ApprovalError('That ticket no longer exists', 404);
      return { ok };
    },
  },
};

function actionLabel(action) {
  return ACTIONS[action]?.label || action;
}

/** Which record an action touched, so the log row points somewhere. */
function entityIdOf(action, payload) {
  return payload.userId || payload.projectId || payload.domainId
    || payload.reportId || payload.ticketId || payload.email || null;
}

// --- storage ---------------------------------------------------------------

function parsePayload(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** The shape the browser reads. Never includes a password or a hash. */
function publicRequest(row, { nameById = new Map() } = {}) {
  const payload = parsePayload(row.payload);
  const { plaintextPassword, password, ...safePayload } = payload;
  if (safePayload.patch) {
    const { password: _pw, ...safePatch } = safePayload.patch;
    safePayload.patch = safePatch;
  }

  return {
    id: row.id,
    action: row.action,
    actionLabel: actionLabel(row.action),
    summary: row.summary,
    status: row.status,
    payload: safePayload,
    requestedBy: row.requestedBy,
    requestedByName: nameById.get(row.requestedBy) || 'Someone',
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt != null ? Number(row.expiresAt) : null,
    decidedBy: row.decidedBy || null,
    decidedByName: row.decidedBy ? nameById.get(row.decidedBy) || 'Someone' : null,
    decidedAt: row.decidedAt || null,
    decisionNote: row.decisionNote || null,
    executedAt: row.executedAt || null,
    executionError: row.executionError || null,
  };
}

/** Pending rows past their window are expired lazily, on read. */
async function expireStale() {
  const now = Date.now();
  const stale = await db.filter(
    'approval_requests',
    (r) => r.status === 'pending' && r.expiresAt != null && Number(r.expiresAt) < now,
  );
  for (const row of stale) {
    await db.update('approval_requests', row.id, {
      status: 'expired',
      decidedAt: new Date().toISOString(),
      decisionNote: 'Nobody signed this off within 48 hours.',
    });
  }
  return stale.length;
}

async function list({ status = null, limit = 100 } = {}) {
  await expireStale();
  const rows = await db.all('approval_requests');
  const users = await db.all('users');
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return rows
    .filter((r) => (status ? r.status === status : true))
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, limit)
    .map((r) => publicRequest(r, { nameById }));
}

async function countPending() {
  await expireStale();
  return (await db.filter('approval_requests', (r) => r.status === 'pending')).length;
}

// --- lifecycle -------------------------------------------------------------

/**
 * Write down a proposal and tell everyone who can release it.
 *
 * Returns the stored row. The caller answers 202 with it -- the change has not
 * happened, and saying otherwise would be a lie the proposer acts on.
 */
async function requestApproval({ actor, action, summary, payload }) {
  if (!ACTIONS[action]) throw new ApprovalError(`Unknown action: ${action}`, 400);

  const row = await db.insert('approval_requests', {
    id: uuidv4(),
    action,
    summary,
    payload: JSON.stringify(payload || {}),
    status: 'pending',
    requestedBy: actor.id,
    requestedAt: new Date().toISOString(),
    expiresAt: Date.now() + TTL_MS,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    executionError: null,
  });

  await alertApprovers(row, actor);
  return row;
}

/** In-app bell and email for everyone entitled to sign this off. */
async function alertApprovers(row, actor) {
  const approvers = await roles.listApprovers({ exceptUserId: actor.id });
  const message = `${actor.name} needs approval: ${row.summary}`;

  for (const approver of approvers) {
    await db.insert('notifications', {
      id: uuidv4(),
      userId: approver.id,
      message,
      type: 'approval',
      read: false,
      createdAt: new Date().toISOString(),
    });
    live.publish('notifications', { to: [approver.id] });
  }

  live.publish('approvals');

  // Email is best-effort: an undelivered alert must not undo the proposal,
  // which is safely parked either way.
  try {
    const mailer = require('./mailer');
    const messages = require('./emailMessages');
    const to = approvers.map((a) => a.email).filter(Boolean);
    if (to.length > 0) {
      await mailer.sendTemplate({
        to,
        message: messages.approvalRequested({
          requesterName: actor.name,
          summary: row.summary,
          actionLabel: actionLabel(row.action),
          requestedAt: row.requestedAt,
        }),
        template: 'approval_requested',
        entity: 'approval_request',
        entityId: row.id,
      });
    }
  } catch (err) {
    console.error('Could not email the approvers:', err.message);
  }

  return approvers.length;
}

/**
 * Sign a proposal off, or turn it down.
 *
 * Approving runs the action immediately and stamps the row in the same pass,
 * so a double-click cannot execute it twice.
 */
async function decide(id, approver, decision, note = null) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ApprovalError('A decision is either approved or rejected', 400);
  }
  if (!roles.canDecideApprovals(approver)) {
    throw new ApprovalError('Only a super admin or a trusted admin can decide this', 403);
  }

  await expireStale();
  const row = await db.find('approval_requests', id);
  if (!row) throw new ApprovalError('That request no longer exists', 404);
  if (row.status !== 'pending') {
    throw new ApprovalError(`That request was already ${row.status}`, 409);
  }
  // Nobody releases their own proposal, however senior they are. The whole
  // point is a second pair of eyes.
  if (row.requestedBy === approver.id) {
    throw new ApprovalError('You cannot approve your own request', 403);
  }

  const decidedAt = new Date().toISOString();

  if (decision === 'rejected') {
    const updated = await db.update('approval_requests', id, {
      status: 'rejected', decidedBy: approver.id, decidedAt, decisionNote: note || null,
    });
    await tellRequester(row, approver, 'rejected', note);
    live.publish('approvals');
    return { request: updated, result: null };
  }

  // Claim the row before running anything, so two approvers racing cannot both
  // execute it.
  const claimed = await db.update('approval_requests', id, {
    status: 'approved', decidedBy: approver.id, decidedAt, decisionNote: note || null,
  });

  try {
    const result = await ACTIONS[row.action].execute(parsePayload(row.payload), {
      requestedBy: row.requestedBy,
      approvedBy: approver.id,
    });
    // Log the change itself, not just the decision. Without this the audit
    // trail shows that something was approved but never what it did.
    await db.insert('activity_log', {
      id: uuidv4(),
      actorId: row.requestedBy,
      action: row.action.split('.')[1] || row.action,
      entity: row.action.split('.')[0],
      entityId: entityIdOf(row.action, parsePayload(row.payload)),
      meta: JSON.stringify({ viaApproval: row.id, approvedBy: approver.id, summary: row.summary }),
      createdAt: new Date().toISOString(),
    });

    const done = await db.update('approval_requests', id, { executedAt: new Date().toISOString() });
    await tellRequester(row, approver, 'approved', note);
    live.publish('approvals');
    live.publish('users');
    return { request: done, result };
  } catch (err) {
    // The signature stands but the change did not land; both facts are on the
    // record rather than one being quietly dropped.
    const failed = await db.update('approval_requests', id, {
      status: 'failed', executionError: err.message,
    });
    live.publish('approvals');
    throw Object.assign(new ApprovalError(`Approved, but the change failed: ${err.message}`, 500), { request: failed });
  }
}

/** Withdrawing your own proposal needs nobody's permission. */
async function cancel(id, actor) {
  const row = await db.find('approval_requests', id);
  if (!row) throw new ApprovalError('That request no longer exists', 404);
  if (row.status !== 'pending') throw new ApprovalError(`That request was already ${row.status}`, 409);
  if (row.requestedBy !== actor.id && !roles.isSuperAdmin(actor)) {
    throw new ApprovalError('Only the person who raised this, or a super admin, can withdraw it', 403);
  }
  const updated = await db.update('approval_requests', id, {
    status: 'cancelled', decidedBy: actor.id, decidedAt: new Date().toISOString(),
  });
  live.publish('approvals');
  return updated;
}

async function tellRequester(row, approver, decision, note) {
  const verb = decision === 'approved' ? 'approved' : 'turned down';
  await db.insert('notifications', {
    id: uuidv4(),
    userId: row.requestedBy,
    message: `${approver.name} ${verb} your request: ${row.summary}${note ? ` -- ${note}` : ''}`,
    type: 'approval',
    read: false,
    createdAt: new Date().toISOString(),
  });
  live.publish('notifications', { to: [row.requestedBy] });

  try {
    const mailer = require('./mailer');
    const messages = require('./emailMessages');
    const requester = await db.find('users', row.requestedBy);
    if (requester?.email) {
      await mailer.sendTemplate({
        to: requester.email,
        message: messages.approvalDecided({
          approverName: approver.name,
          summary: row.summary,
          decision,
          note,
        }),
        template: 'approval_decided',
        entity: 'approval_request',
        entityId: row.id,
      });
    }
  } catch (err) {
    console.error('Could not email the requester:', err.message);
  }
}

// --- the gate routes call --------------------------------------------------

/**
 * The one line a sensitive route adds.
 *
 * ```js
 * const gate = await approvals.gate(req, res, {
 *   action: 'user.delete',
 *   summary: `Delete the account for ${target.name}`,
 *   payload: { userId: target.id },
 * });
 * if (gate.held) return;   // 202 already sent; nothing was changed
 * ```
 *
 * Returns `{ held: false }` for anyone who may act alone, and the route
 * carries on exactly as it did before this file existed.
 */
async function gate(req, res, { action, summary, payload }) {
  if (!roles.needsApproval(req.user)) return { held: false };

  const row = await requestApproval({ actor: req.user, action, summary, payload });
  res.status(202).json({
    pendingApproval: true,
    request: publicRequest(row, { nameById: new Map([[req.user.id, req.user.name]]) }),
    message: 'Sent to the other admins for approval. Nothing has changed yet.',
  });
  return { held: true, request: row };
}

module.exports = {
  ACTIONS,
  ApprovalError,
  TTL_MS,
  actionLabel,
  publicRequest,
  parsePayload,
  list,
  countPending,
  requestApproval,
  decide,
  cancel,
  gate,
  expireStale,
};
