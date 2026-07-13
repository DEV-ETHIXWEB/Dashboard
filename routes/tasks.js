'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');

router.use(requireAuth);

function visibleTo(user, task) {
  if (user.role === 'admin' || user.role === 'sales' || user.role === 'project_manager') return true;
  if (user.role === 'employee') return task.assigneeId === user.id;
  if (user.role === 'client') {
    const project = db.find('projects', task.projectId);
    return project && project.clientId === user.id;
  }
  return false;
}

router.get('/', (req, res) => {
  let tasks = db.all('tasks').filter((t) => visibleTo(req.user, t));
  if (req.query.projectId) tasks = tasks.filter((t) => t.projectId === req.query.projectId);
  res.json({ tasks });
});

router.post('/', requireCSRF, requireRole('admin', 'project_manager'), (req, res) => {
  const { projectId, name, assigneeId, priority, due } = req.body || {};
  if (!projectId || !name) return res.status(400).json({ error: 'projectId and name are required' });
  const project = db.find('projects', projectId);
  if (!project) return res.status(400).json({ error: 'Project not found' });

  const task = db.insert('tasks', {
    projectId, name, assigneeId: assigneeId || null, status: 'To Do',
    priority: priority || 'Medium', due: due || null,
  });
  audit(req.user.id, 'create', 'task', task.id);
  if (assigneeId) notify(assigneeId, `You were assigned a new task: "${name}"`, 'task');
  res.status(201).json({ task });
});

router.put('/:id', requireCSRF, (req, res) => {
  const task = db.find('tasks', req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const isManager = ['admin', 'project_manager'].includes(req.user.role);
  const isOwnTask = req.user.role === 'employee' && task.assigneeId === req.user.id;
  if (!isManager && !isOwnTask) return res.status(403).json({ error: 'Not allowed to edit this task' });

  // Employees may only change status; managers/admins can edit everything.
  const patch = isManager ? { ...req.body } : { status: req.body.status };
  delete patch.id;

  const updated = db.update('tasks', req.params.id, patch);
  audit(req.user.id, 'update', 'task', req.params.id);

  if (patch.status && patch.status !== task.status) {
    const project = db.find('projects', task.projectId);
    if (project?.assignedPmId) notify(project.assignedPmId, `Task "${task.name}" moved to ${patch.status}`, 'task');
  }
  if (patch.assigneeId && patch.assigneeId !== task.assigneeId) {
    notify(patch.assigneeId, `You were assigned to task: "${task.name}"`, 'task');
  }
  res.json({ task: updated });
});

router.delete('/:id', requireCSRF, requireRole('admin', 'project_manager'), (req, res) => {
  const ok = db.remove('tasks', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Task not found' });
  audit(req.user.id, 'delete', 'task', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
