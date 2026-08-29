'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const slack = require('../utils/slack');

router.use(requireAuth);

async function visibleTo(user, task) {
  if (user.role === 'admin' || user.role === 'sales' || user.role === 'project_manager') return true;
  if (user.role === 'employee') return task.assigneeId === user.id;
  if (user.role === 'client') {
    const project = await db.find('projects', task.projectId);
    return project && project.clientId === user.id;
  }
  return false;
}

router.get('/', async (req, res, next) => {
  try {
    let tasks = await db.all('tasks');

    // A client sees a task when they own the project it sits on. visibleTo
    // resolves that a task at a time; the projects are read once here instead.
    if (req.user.role === 'client') {
      const projects = await db.filter('projects', (p) => p.clientId === req.user.id);
      const mine = new Set(projects.map((p) => p.id));
      tasks = tasks.filter((t) => mine.has(t.projectId));
    } else {
      const visible = [];
      for (const t of tasks) if (await visibleTo(req.user, t)) visible.push(t);
      tasks = visible;
    }

    if (req.query.projectId) tasks = tasks.filter((t) => t.projectId === req.query.projectId);
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin', 'project_manager'), async (req, res, next) => {
  try {
    const { projectId, name, assigneeId, priority, due } = req.body || {};
    if (!projectId || !name) return res.status(400).json({ error: 'projectId and name are required' });
    const project = await db.find('projects', projectId);
    if (!project) return res.status(400).json({ error: 'Project not found' });

    const task = await db.insert('tasks', {
      projectId, name, assigneeId: assigneeId || null, status: 'To Do',
      priority: priority || 'Medium', due: due || null,
    });
    await audit(req.user.id, 'create', 'task', task.id);
    if (assigneeId) await notify(assigneeId, `You were assigned a new task: "${name}"`, 'task');
    slack.notifySlack(`📝 *New Task Created:* "${name}" (Project: ${project.name}, Priority: ${priority || 'Medium'})`);
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCSRF, async (req, res, next) => {
  try {
    const task = await db.find('tasks', req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const isManager = ['admin', 'project_manager'].includes(req.user.role);
    const isOwnTask = req.user.role === 'employee' && task.assigneeId === req.user.id;
    if (!isManager && !isOwnTask) return res.status(403).json({ error: 'Not allowed to edit this task' });

    const patch = isManager ? { ...req.body } : { status: req.body.status };
    delete patch.id;

    const updated = await db.update('tasks', req.params.id, patch);
    await audit(req.user.id, 'update', 'task', req.params.id);

    if (patch.status && patch.status !== task.status) {
      const project = await db.find('projects', task.projectId);
      if (project?.assignedPmId) await notify(project.assignedPmId, `Task "${task.name}" moved to ${patch.status}`, 'task');
      if (patch.status === 'Done') {
        slack.notifySlack(`✅ *Task Completed:* "${task.name}"`);
      }
    }
    if (patch.assigneeId && patch.assigneeId !== task.assigneeId) {
      await notify(patch.assigneeId, `You were assigned to task: "${task.name}"`, 'task');
    }
    res.json({ task: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin', 'project_manager'), async (req, res, next) => {
  try {
    const ok = await db.remove('tasks', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    await audit(req.user.id, 'delete', 'task', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
