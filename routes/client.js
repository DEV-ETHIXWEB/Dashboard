'use strict';

/**
 * The client's window onto work in progress.
 *
 * A client has no ClickUp seat and no Slack account, and must never get either
 * token. So the server reads both on their behalf and hands back only what
 * belongs to them: their own tickets, the live state of the ClickUp task each
 * one mirrors, and the Slack thread that ticket opened.
 *
 * Two rules make that safe:
 *   1. Scope is derived from the session, never from a query parameter. Staff
 *      may pass ?clientId= to look at one account; a client cannot.
 *   2. Slack thread visibility defaults to dashboard-posted messages only.
 *      Teammates talk freely in that thread; CLIENT_SLACK_THREAD=full opts a
 *      workspace into showing the human replies as well.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireCSRF } = require('../middleware/auth');
const { requirePage } = require('../utils/clientPages');
const clickup = require('../utils/clickup');
const slack = require('../utils/slack');
const workflow = require('../utils/ticketWorkflow');
const messages = require('../utils/emailMessages');

router.use(requireAuth);
router.use(requirePage('progress'));

const STAFF_ROLES = ['admin', 'project_manager', 'sales', 'employee'];

function showsFullSlackThread() {
  return String(process.env.CLIENT_SLACK_THREAD || 'summary').toLowerCase() === 'full';
}

/**
 * Whose progress this request is about. Clients are pinned to themselves; staff
 * may name a client, and default to the first one they have work for.
 */
async function resolveScope(req) {
  if (req.user.role === 'client') return req.user;
  if (!STAFF_ROLES.includes(req.user.role)) return null;

  const requested = req.query.clientId;
  if (requested) {
    const client = await db.find('users', requested);
    return client && client.role === 'client' ? client : null;
  }
  const clients = await db.filter('users', (u) => u.role === 'client');
  return clients.sort((a, b) => a.name.localeCompare(b.name))[0] || null;
}

/** Client-safe view of a ticket: no internal ids, no assignee email. */
function publicTicket(ticket, { assigneeName = null } = {}) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority || 'Normal',
    stage: ticket.stage || null,
    stageLabel: messages.stageLabel(ticket.stage),
    progress: ticket.progress ?? 0,
    createdAt: ticket.createdAt,
    responseDueAt: ticket.responseDueAt ?? null,
    firstResponseAt: ticket.firstResponseAt ?? null,
    ownerName: assigneeName,
    hasBoardTask: Boolean(ticket.clickupTaskId),
    hasThread: Boolean(ticket.slackChannelId && ticket.slackThreadTs),
  };
}

/** Live ClickUp state for a mirrored ticket, or null when unavailable. */
async function boardStateFor(ticket) {
  if (!ticket.clickupTaskId || !clickup.isEnabled()) return null;
  try {
    const task = await clickup.fetchTask(ticket.clickupTaskId);
    return {
      status: task.status,
      statusType: task.statusType,
      statusColor: task.statusColor,
      dueAt: task.dueAt,
      updatedAt: task.updatedAt,
      listName: task.listName,
      assignees: task.assignees.map((a) => a.name),
    };
  } catch (err) {
    console.error(`Could not read the ClickUp task for ticket ${ticket.id}:`, err.message);
    return null;
  }
}

/**
 * The progress board: every ticket this client has, with the live task-board
 * state attached where one exists.
 */
router.get('/progress', async (req, res, next) => {
  try {
    const client = await resolveScope(req);
    if (!client) return res.json({ client: null, tickets: [], projects: [], summary: emptySummary(), integrations: integrationFlags() });

    const [tickets, projects, users] = await Promise.all([
      db.filter('tickets', (t) => t.clientId === client.id),
      db.filter('projects', (p) => p.clientId === client.id),
      db.all('users'),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const sorted = tickets.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const enriched = [];
    for (const ticket of sorted) {
      enriched.push({
        ...publicTicket(ticket, { assigneeName: ticket.assigneeId ? nameById.get(ticket.assigneeId) || null : null }),
        board: await boardStateFor(ticket),
      });
    }

    const open = enriched.filter((t) => !['Resolved', 'Closed'].includes(t.status));
    res.json({
      client: { id: client.id, name: client.name, company: client.company || null },
      tickets: enriched,
      projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status, type: p.type })),
      summary: {
        open: open.length,
        resolved: enriched.length - open.length,
        averageProgress: open.length
          ? Math.round(open.reduce((sum, t) => sum + (t.progress || 0), 0) / open.length)
          : 0,
        nextDeadline: open
          .map((t) => t.responseDueAt)
          .filter(Boolean)
          .sort((a, b) => a - b)[0] || null,
        activeProjects: projects.filter((p) => p.status !== 'Complete').length,
      },
      integrations: integrationFlags(),
    });
  } catch (err) {
    next(err);
  }
});

function emptySummary() {
  return { open: 0, resolved: 0, averageProgress: 0, nextDeadline: null, activeProjects: 0 };
}

function integrationFlags() {
  return {
    board: clickup.isEnabled(),
    chat: slack.isEnabled(),
    chatMode: showsFullSlackThread() ? 'full' : 'summary',
  };
}

/** Load the ticket named in the URL and prove the caller is allowed to see it. */
async function loadOwnTicket(req, res, next) {
  try {
    const ticket = await db.find('tickets', req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!(await workflow.canView(req.user, ticket))) {
      return res.status(403).json({ error: 'Not allowed to view this ticket' });
    }
    req.ticket = ticket;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * One ticket, told three ways: the team's own notes, the comments on the
 * ClickUp task, and the Slack thread. Each source is optional and each failure
 * is reported rather than hidden, so "no updates yet" never gets confused with
 * "the integration is down".
 */
router.get('/tickets/:id/activity', loadOwnTicket, async (req, res, next) => {
  try {
    const ticket = req.ticket;
    const [updates, users] = await Promise.all([workflow.listUpdates(ticket.id), db.all('users')]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const roleById = new Map(users.map((u) => [u.id, u.role]));

    // Internal requests between teammates are not the client's business; notes
    // and system lines are.
    const notes = updates
      .filter((u) => ['progress', 'system'].includes(u.kind) && u.body)
      .map((u) => ({
        id: u.id,
        author: nameById.get(u.authorId) || 'Team',
        authorRole: roleById.get(u.authorId) || 'employee',
        body: u.body,
        progress: u.progress,
        stage: u.stage,
        stageLabel: messages.stageLabel(u.stage),
        at: u.createdAt,
      }));

    // `enabled` and `linked` are separate on purpose: "the workspace has no
    // task board" and "this ticket predates mirroring" need different words.
    const board = {
      enabled: clickup.isEnabled(),
      linked: Boolean(ticket.clickupTaskId),
      available: false,
      comments: [],
      error: null,
      url: ticket.clickupTaskUrl || null,
    };
    if (ticket.clickupTaskId && clickup.isEnabled()) {
      try {
        const comments = await clickup.fetchComments(ticket.clickupTaskId);
        board.available = true;
        board.comments = comments.map((c) => ({
          id: c.id, author: c.authorName, body: c.text, at: c.createdAt,
        }));
      } catch (err) {
        board.error = err.message;
      }
    }

    const chat = {
      enabled: slack.isEnabled(),
      linked: Boolean(ticket.slackChannelId && ticket.slackThreadTs),
      available: false,
      mode: showsFullSlackThread() ? 'full' : 'summary',
      messages: [],
      error: null,
    };
    if (ticket.slackChannelId && ticket.slackThreadTs && slack.isEnabled()) {
      try {
        const replies = await slack.fetchMessageReplies(ticket.slackChannelId, ticket.slackThreadTs);
        const visible = showsFullSlackThread() ? replies : replies.filter((m) => m.isBot);
        chat.available = true;
        chat.messages = visible.map((m) => ({
          id: m.id, author: m.authorName, body: m.text, at: m.at, isBot: m.isBot,
        }));
      } catch (err) {
        chat.error = err.message;
      }
    }

    res.json({
      ticket: publicTicket(ticket, {
        assigneeName: ticket.assigneeId ? nameById.get(ticket.assigneeId) || null : null,
      }),
      notes,
      board,
      chat,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Reply on a ticket from the progress board. Goes through the same workflow the
 * ticket timeline uses, so it lands in the Slack thread and on the ClickUp task
 * exactly like a reply posted anywhere else.
 */
router.post('/tickets/:id/reply', requireCSRF, loadOwnTicket, async (req, res, next) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Write something before sending.' });
    if (body.length > 4000) return res.status(400).json({ error: 'Keep a reply under 4000 characters.' });

    const update = await workflow.addProgressUpdate(req.user, req.ticket, { body });
    res.status(201).json({
      update: { id: update.id, body: update.body, at: update.createdAt, author: req.user.name },
    });
  } catch (err) {
    if (err instanceof workflow.WorkflowError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
