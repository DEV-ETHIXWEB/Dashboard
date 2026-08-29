'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const cache = require('../utils/integrationCache');
const clickup = require('../utils/clickup');
const slack = require('../utils/slack');

router.use(requireAuth, requireRole('admin'));

/**
 * ClickUp/Slack failures are upstream problems, not bugs in this app -- surface
 * them to the admin with their own status instead of a generic 500.
 */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof clickup.ClickUpError || err instanceof slack.SlackError) {
        return res.status(err.status || 502).json({ error: err.message });
      }
      next(err);
    }
  };
}

router.get('/status', (req, res) => {
  res.json({
    clickup: {
      connected: clickup.isEnabled(),
      ticketMirroring: clickup.isTicketMirroringEnabled(),
      ticketsListId: clickup.ticketsListId(),
      taskMirroring: clickup.isTaskMirroringEnabled(),
      tasksListId: clickup.tasksListId(),
    },
    slack: { connected: slack.isEnabled() },
  });
});

// --- ClickUp ---------------------------------------------------------------

router.get('/clickup/overview', handle(async (req, res) => {
  const overview = await clickup.fetchOverview({ spaceId: req.query.spaceId || undefined });
  res.json(overview);
}));

router.get('/clickup/tree', handle(async (req, res) => {
  res.json(await clickup.fetchTree());
}));

router.get('/clickup/lists/:listId/tasks', handle(async (req, res) => {
  res.json({ tasks: await clickup.fetchListTasks(req.params.listId) });
}));

router.get('/clickup/lists/:listId/statuses', handle(async (req, res) => {
  res.json({ statuses: await clickup.fetchListStatuses(req.params.listId) });
}));

router.get('/clickup/members', handle(async (req, res) => {
  res.json({ members: await clickup.fetchMembers() });
}));

// --- ClickUp writes --------------------------------------------------------
// These let an admin run ClickUp entirely from this dashboard.

router.post('/clickup/lists/:listId/tasks', requireCSRF, handle(async (req, res) => {
  const task = await clickup.createTask(req.params.listId, req.body || {});
  await audit(req.user.id, 'create', 'clickup_task', task.id, { listId: req.params.listId });
  res.status(201).json({ task });
}));

router.put('/clickup/tasks/:taskId', requireCSRF, handle(async (req, res) => {
  const task = await clickup.updateTask(req.params.taskId, req.body || {});
  await audit(req.user.id, 'update', 'clickup_task', req.params.taskId);
  res.json({ task });
}));

router.delete('/clickup/tasks/:taskId', requireCSRF, handle(async (req, res) => {
  await clickup.deleteTask(req.params.taskId);
  await audit(req.user.id, 'delete', 'clickup_task', req.params.taskId);
  res.json({ ok: true });
}));

router.get('/clickup/tasks/:taskId/comments', handle(async (req, res) => {
  res.json({ comments: await clickup.fetchComments(req.params.taskId) });
}));

router.post('/clickup/tasks/:taskId/comments', requireCSRF, handle(async (req, res) => {
  await clickup.addComment(req.params.taskId, req.body?.text);
  res.status(201).json({ ok: true });
}));

// --- Slack -----------------------------------------------------------------

router.get('/slack/channels', handle(async (req, res) => {
  res.json({ channels: await slack.fetchChannels() });
}));

router.get('/slack/feed', handle(async (req, res) => {
  const channelIds = String(req.query.channels || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const perChannel = Math.min(Math.max(Number(req.query.perChannel) || 30, 1), 100);
  res.json(await slack.fetchCategorisedFeed({ channelIds, perChannel }));
}));

router.get('/slack/channels/:channelId/messages', handle(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  res.json({ messages: await slack.fetchChannelMessages(req.params.channelId, { limit }) });
}));

router.get('/slack/channels/:channelId/messages/:messageTs/replies', handle(async (req, res) => {
  const replies = await slack.fetchMessageReplies(req.params.channelId, req.params.messageTs);
  res.json({ replies });
}));

router.post('/slack/messages', requireCSRF, handle(async (req, res) => {
  const { channelId, text, threadTs } = req.body || {};
  const result = await slack.postMessage({ channelId, text, threadTs });
  cache.invalidate('slack:');
  await audit(req.user.id, 'create', 'slack_message', result.ts, { channelId });
  res.status(201).json(result);
}));

router.post('/slack/convert-to-task', requireCSRF, handle(async (req, res) => {
  const { projectId, name, assigneeId, priority, due, slackMessageUrl, text } = req.body || {};
  if (!projectId || !name) return res.status(400).json({ error: 'projectId and name are required' });
  const project = await db.find('projects', projectId);
  if (!project) return res.status(400).json({ error: 'Project not found' });

  const description = `Converted from Slack message:\n"${text || name}"\nPermalink: ${slackMessageUrl || ''}`;
  const task = await db.insert('tasks', {
    projectId,
    name,
    description,
    assigneeId: assigneeId || null,
    status: 'To Do',
    priority: priority || 'Medium',
    due: due || null,
    source: 'slack',
  });
  await audit(req.user.id, 'create', 'task', task.id, { source: 'slack' });
  if (assigneeId) await notify(assigneeId, `New task assigned from Slack: "${name}"`, 'task');

  // Trigger notification back to Slack
  await slack.notifySlack(`📌 Task created in Dashboard from Slack message: *${name}* (Project: ${project.name})`);

  res.status(201).json({ task });
}));

router.post('/slack/send-digest', requireCSRF, handle(async (req, res) => {
  const { channelId } = req.body || {};
  const tasks = await db.all('tasks');
  const projects = await db.all('projects');
  const result = await slack.sendSlackDigest({ channelId, tasks, projects });
  await audit(req.user.id, 'send', 'slack_digest', result.ts, { channelId });
  res.json({ ok: true, result });
}));

// --- cache -----------------------------------------------------------------

router.post('/refresh', requireCSRF, (req, res) => {
  const scope = req.query.scope;
  if (scope === 'slack' || scope === 'clickup') cache.invalidate(`${scope}:`);
  else cache.invalidate();
  res.json({ ok: true });
});

module.exports = router;
