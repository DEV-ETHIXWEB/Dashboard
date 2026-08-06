'use strict';

const express = require('express');
const router = express.Router();

const { requireAuth, requireRole, requireCSRF, audit } = require('../middleware/auth');
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

// --- cache -----------------------------------------------------------------

router.post('/refresh', requireCSRF, (req, res) => {
  const scope = req.query.scope;
  if (scope === 'slack' || scope === 'clickup') cache.invalidate(`${scope}:`);
  else cache.invalidate();
  res.json({ ok: true });
});

module.exports = router;
