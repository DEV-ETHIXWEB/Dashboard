'use strict';

// Domain logic for how a ticket moves: progress notes, stage/percent tracking,
// handover requests, and collaboration requests.
//
// Everything a ticket has ever had done to it lives in one `ticket_updates`
// table. A handover or collaboration request is just an update with a target
// user and a pending/accepted/declined status, so the ticket timeline stays a
// single ordered list instead of three tables the UI has to interleave.

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/setup');
const { audit } = require('../middleware/auth');
const mailer = require('./mailer');
const messages = require('./emailMessages');
const intake = require('./ticketIntake');

/**
 * Notify any user regardless of role.
 *
 * middleware/auth's `notify` drops anything aimed at staff, which is right for
 * client-facing announcements but useless here -- a handover request that never
 * reaches the person being asked is not a request.
 */
async function notify(userId, message, type = 'ticket') {
  if (!userId) return;
  const user = await db.find('users', userId);
  if (!user) return;
  await db.insert('notifications', {
    id: uuidv4(), userId, message, type, read: false, createdAt: new Date().toISOString(),
  });
}

const KINDS = { PROGRESS: 'progress', HANDOVER: 'handover', COLLABORATION: 'collaboration', SYSTEM: 'system' };
const REQUEST_KINDS = new Set([KINDS.HANDOVER, KINDS.COLLABORATION]);

const REQUEST_STATUS = { PENDING: 'pending', ACCEPTED: 'accepted', DECLINED: 'declined' };

/** Stages in the order work actually flows, with the progress each implies. */
const STAGES = [
  { key: 'triage', label: 'Triage', progress: 0 },
  { key: 'in_progress', label: 'In progress', progress: 30 },
  { key: 'waiting_on_client', label: 'Waiting on client', progress: 50 },
  { key: 'review', label: 'Review', progress: 80 },
  { key: 'done', label: 'Done', progress: 100 },
];
const STAGE_KEYS = new Set(STAGES.map((s) => s.key));

const STAFF_ROLES = ['admin', 'project_manager', 'employee'];
const MANAGER_ROLES = ['admin', 'project_manager'];

class WorkflowError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkflowError';
    this.status = status;
  }
}

// --- collaborators ---------------------------------------------------------

async function listCollaborators(ticketId) {
  return db.filter('ticket_collaborators', (c) => c.ticketId === ticketId);
}

async function collaboratorIds(ticketId) {
  return (await listCollaborators(ticketId)).map((c) => c.userId);
}

// --- access ----------------------------------------------------------------

/**
 * Who may read a ticket and its timeline. Employees see a ticket when they are
 * the assignee OR a collaborator -- collaboration is pointless if the person
 * pulled in still cannot open it.
 */
async function canView(user, ticket) {
  if (MANAGER_ROLES.includes(user.role) || user.role === 'sales') return true;
  if (user.role === 'client') return ticket.clientId === user.id;
  if (user.role === 'employee') {
    if (ticket.assigneeId === user.id) return true;
    return (await collaboratorIds(ticket.id)).includes(user.id);
  }
  return false;
}

/** Who may record progress: managers, the assignee, or an accepted collaborator. */
async function canRecordProgress(user, ticket) {
  if (MANAGER_ROLES.includes(user.role)) return true;
  if (user.role !== 'employee') return false;
  if (ticket.assigneeId === user.id) return true;
  return (await collaboratorIds(ticket.id)).includes(user.id);
}

/** Who may ask someone else to take over or help: managers or the assignee. */
function canDelegate(user, ticket) {
  return MANAGER_ROLES.includes(user.role) || ticket.assigneeId === user.id;
}

// --- timeline --------------------------------------------------------------

async function listUpdates(ticketId) {
  const updates = await db.filter('ticket_updates', (u) => u.ticketId === ticketId);
  return updates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function insertUpdate(fields) {
  return db.insert('ticket_updates', {
    id: uuidv4(),
    body: null,
    progress: null,
    stage: null,
    targetUserId: null,
    status: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    ...fields,
  });
}

// --- progress --------------------------------------------------------------

function normaliseProgress(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new WorkflowError('Progress must be a number between 0 and 100.');
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normaliseStage(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value);
  if (!STAGE_KEYS.has(key)) throw new WorkflowError(`"${value}" is not a valid stage.`);
  return key;
}

/**
 * Post a note on a ticket, optionally moving its stage and percentage.
 * Clients may leave a note but never move the tracker -- that is the team's
 * account of the work, and it drives what the client sees as progress.
 */
async function addProgressUpdate(user, ticket, { body, progress, stage } = {}) {
  const isClient = user.role === 'client';
  const text = typeof body === 'string' ? body.trim() : '';

  const nextStage = isClient ? null : normaliseStage(stage);
  let nextProgress = isClient ? null : normaliseProgress(progress);

  // Choosing a stage without a number fills in that stage's usual percentage,
  // so the common case is one click rather than two decisions.
  if (nextStage && nextProgress === null) {
    nextProgress = STAGES.find((s) => s.key === nextStage).progress;
  }

  if (!text && nextProgress === null && nextStage === null) {
    throw new WorkflowError('Write an update, or set a stage or progress.');
  }

  const update = await insertUpdate({
    ticketId: ticket.id,
    authorId: user.id,
    kind: KINDS.PROGRESS,
    body: text || null,
    progress: nextProgress,
    stage: nextStage,
  });

  const patch = {};
  if (nextProgress !== null) patch.progress = nextProgress;
  if (nextStage !== null) patch.stage = nextStage;
  if (Object.keys(patch).length > 0) await db.update('tickets', ticket.id, patch);

  await audit(user.id, 'update', 'ticket_progress', ticket.id, patch);

  // Tell the client something moved; tell the team when the client replies.
  if (isClient) {
    for (const staffId of await interestedStaff(ticket)) {
      await notify(staffId, `${user.name} replied on ticket "${ticket.subject}"`, 'ticket');
    }
  } else {
    await notify(ticket.clientId, `Update on your ticket "${ticket.subject}"`, 'ticket');
  }

  // Email and the outside world (Slack thread, ClickUp task) are best-effort:
  // the update is already saved, and no integration outage may undo that.
  try {
    await announceUpdate({ user, ticket: { ...ticket, ...patch }, update, isClient });
  } catch (err) {
    console.error(`Could not announce the update on ticket ${ticket.id}:`, err.message);
  }

  return update;
}

/**
 * Fan one ticket note out to email, the ticket's Slack thread, and its ClickUp
 * task, so nobody has to watch three places to stay current.
 */
async function announceUpdate({ user, ticket, update, isClient }) {
  const body = update.body || '';
  const stageText = update.stage ? ` [${messages.stageLabel(update.stage)}]` : '';
  const progressText = update.progress === null || update.progress === undefined ? '' : ` (${update.progress}%)`;

  await intake.echoActivity(
    ticket,
    `💬 *${user.name}*${stageText}${progressText} on ${ticket.id}\n${body || '_tracker updated_'}`,
  );

  if (isClient) {
    // The team hears about a client reply by email as well as in the bell.
    const staffIds = await interestedStaff(ticket);
    const staff = (await Promise.all(staffIds.map((id) => db.find('users', id)))).filter(Boolean);
    const inboxes = staff.map((s) => s.email);
    if (inboxes.length > 0) {
      await mailer.sendTemplate({
        to: inboxes,
        message: messages.ticketComment({
          ticket, authorName: user.name, body, progress: update.progress, stage: update.stage, forClient: false,
        }),
        template: 'ticket_comment',
        entity: 'ticket',
        entityId: ticket.id,
      });
    }
    return;
  }

  const client = ticket.clientId ? await db.find('users', ticket.clientId) : null;
  if (!client?.email) return;
  await mailer.sendTemplate({
    to: client.email,
    message: messages.ticketComment({
      ticket, authorName: user.name, body, progress: update.progress, stage: update.stage, forClient: true,
    }),
    template: 'ticket_comment',
    entity: 'ticket',
    entityId: ticket.id,
  });
}

/** Assignee plus collaborators -- everyone actually working the ticket. */
async function interestedStaff(ticket) {
  const ids = new Set(await collaboratorIds(ticket.id));
  if (ticket.assigneeId) ids.add(ticket.assigneeId);
  return [...ids];
}

// --- handover / collaboration requests -------------------------------------

async function createRequest(user, ticket, kind, { targetUserId, note } = {}) {
  if (!REQUEST_KINDS.has(kind)) throw new WorkflowError('Unknown request type.');
  if (!canDelegate(user, ticket)) {
    throw new WorkflowError('Only the assignee or a manager can ask someone else to take this on.', 403);
  }
  if (!targetUserId) throw new WorkflowError('Pick who you are asking.', 400);
  if (targetUserId === user.id) throw new WorkflowError('You cannot send this request to yourself.', 400);

  const target = await db.find('users', targetUserId);
  if (!target || !STAFF_ROLES.includes(target.role)) {
    throw new WorkflowError('That person is not on the team.', 400);
  }
  if (kind === KINDS.HANDOVER && ticket.assigneeId === targetUserId) {
    throw new WorkflowError('That person already owns this ticket.', 400);
  }
  if (kind === KINDS.COLLABORATION && (await collaboratorIds(ticket.id)).includes(targetUserId)) {
    throw new WorkflowError('That person is already collaborating on this ticket.', 400);
  }

  // One open request per person per kind, so a ticket can't collect duplicates.
  const existing = await db.filter('ticket_updates', (u) =>
    u.ticketId === ticket.id && u.kind === kind
    && u.targetUserId === targetUserId && u.status === REQUEST_STATUS.PENDING);
  if (existing.length > 0) throw new WorkflowError('That request is already waiting on them.', 409);

  const update = await insertUpdate({
    ticketId: ticket.id,
    authorId: user.id,
    kind,
    body: typeof note === 'string' && note.trim() ? note.trim() : null,
    targetUserId,
    status: REQUEST_STATUS.PENDING,
  });

  await audit(user.id, 'create', `ticket_${kind}_request`, ticket.id, { targetUserId });
  await notify(
    targetUserId,
    kind === KINDS.HANDOVER
      ? `${user.name} asked you to take over ticket "${ticket.subject}"`
      : `${user.name} asked you to help on ticket "${ticket.subject}"`,
    'ticket',
  );

  // A request nobody notices is a stalled ticket, so it goes to their inbox too.
  try {
    await mailer.sendTemplate({
      to: target.email,
      message: messages.ticketRequest({
        ticket, kind, fromName: user.name, toName: target.name, note: update.body,
      }),
      template: 'ticket_request',
      entity: 'ticket',
      entityId: ticket.id,
    });
  } catch (err) {
    console.error(`Could not email the ${kind} request on ticket ${ticket.id}:`, err.message);
  }

  return update;
}

/**
 * Accept or decline a pending request. Only the person being asked can answer
 * it -- or an admin, who can unblock a request aimed at someone unavailable.
 */
async function respondToRequest(user, ticket, requestId, accept) {
  const request = await db.find('ticket_updates', requestId);
  if (!request || request.ticketId !== ticket.id) throw new WorkflowError('Request not found.', 404);
  if (!REQUEST_KINDS.has(request.kind)) throw new WorkflowError('That is not a request.', 400);
  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new WorkflowError('That request has already been answered.', 409);
  }
  if (request.targetUserId !== user.id && user.role !== 'admin') {
    throw new WorkflowError('Only the person being asked can answer this.', 403);
  }

  const status = accept ? REQUEST_STATUS.ACCEPTED : REQUEST_STATUS.DECLINED;
  const resolved = await db.update('ticket_updates', requestId, {
    status,
    resolvedAt: new Date().toISOString(),
  });

  if (accept) {
    if (request.kind === KINDS.HANDOVER) {
      // Ownership moves; the previous owner stays on as a collaborator so they
      // keep access to a ticket they have context on.
      const previousAssignee = ticket.assigneeId;
      await db.update('tickets', ticket.id, { assigneeId: request.targetUserId });
      if (previousAssignee && previousAssignee !== request.targetUserId) {
        await addCollaborator(ticket.id, previousAssignee, request.targetUserId);
      }
      await removeCollaboratorRow(ticket.id, request.targetUserId);
    } else {
      await addCollaborator(ticket.id, request.targetUserId, request.authorId);
    }
  }

  await insertUpdate({
    ticketId: ticket.id,
    authorId: user.id,
    kind: KINDS.SYSTEM,
    body: accept
      ? `${user.name} accepted the ${request.kind === KINDS.HANDOVER ? 'handover' : 'collaboration'} request.`
      : `${user.name} declined the ${request.kind === KINDS.HANDOVER ? 'handover' : 'collaboration'} request.`,
  });

  await audit(user.id, 'update', `ticket_${request.kind}_request`, ticket.id, { status });

  try {
    await intake.echoActivity(
      ticket,
      `${accept ? '✅' : '🚫'} *${user.name}* ${accept ? 'accepted' : 'declined'} the ${request.kind} request on ${ticket.id}`,
    );
  } catch (err) {
    console.error(`Could not echo the request outcome on ticket ${ticket.id}:`, err.message);
  }

  if (request.authorId && request.authorId !== user.id) {
    await notify(
      request.authorId,
      `${user.name} ${accept ? 'accepted' : 'declined'} your request on "${ticket.subject}"`,
      'ticket',
    );
  }

  return resolved;
}

async function addCollaborator(ticketId, userId, addedBy) {
  const already = await db.filter('ticket_collaborators', (c) => c.ticketId === ticketId && c.userId === userId);
  if (already.length > 0) return already[0];
  return db.insert('ticket_collaborators', {
    id: uuidv4(), ticketId, userId, addedBy: addedBy || null, createdAt: new Date().toISOString(),
  });
}

async function removeCollaboratorRow(ticketId, userId) {
  const rows = await db.filter('ticket_collaborators', (c) => c.ticketId === ticketId && c.userId === userId);
  for (const row of rows) await db.remove('ticket_collaborators', row.id);
  return rows.length > 0;
}

async function removeCollaborator(user, ticket, userId) {
  if (!canDelegate(user, ticket) && user.id !== userId) {
    throw new WorkflowError('Only the assignee, a manager, or that person can remove them.', 403);
  }
  const removed = await removeCollaboratorRow(ticket.id, userId);
  if (!removed) throw new WorkflowError('That person is not a collaborator.', 404);
  await audit(user.id, 'delete', 'ticket_collaborator', ticket.id, { userId });
  return true;
}

/** Every pending request aimed at this user, for the admin home and inbox. */
async function pendingRequestsFor(userId) {
  return db.filter('ticket_updates', (u) =>
    REQUEST_KINDS.has(u.kind) && u.status === REQUEST_STATUS.PENDING && u.targetUserId === userId);
}

async function allPendingRequests() {
  return db.filter('ticket_updates', (u) => REQUEST_KINDS.has(u.kind) && u.status === REQUEST_STATUS.PENDING);
}

module.exports = {
  KINDS, REQUEST_STATUS, STAGES, WorkflowError,
  canView, canRecordProgress, canDelegate,
  listUpdates, listCollaborators, collaboratorIds,
  addProgressUpdate, createRequest, respondToRequest,
  addCollaborator, removeCollaborator,
  pendingRequestsFor, allPendingRequests,
};
