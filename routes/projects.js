'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');

const STATUS_PCT = { 'To Do': 0, 'In Progress': 50, 'In Review': 90, Complete: 100 };

router.use(requireAuth);

function withProgress(project) {
  const tasks = db.filter('tasks', (t) => t.projectId === project.id);
  const total = tasks.length;
  const complete = tasks.filter((t) => t.status === 'Complete').length;
  const pct = total === 0 ? 0 : Math.round(tasks.reduce((sum, t) => sum + (STATUS_PCT[t.status] ?? 0), 0) / total);
  return { ...project, progress: { pct, complete, total } };
}

function visibleTo(user, project) {
  if (user.role === 'admin' || user.role === 'sales' || user.role === 'project_manager') return true;
  if (user.role === 'client') return project.clientId === user.id;
  if (user.role === 'employee') return db.filter('tasks', (t) => t.projectId === project.id && t.assigneeId === user.id).length > 0;
  return false;
}

router.get('/', (req, res) => {
  const projects = db.all('projects').filter((p) => visibleTo(req.user, p)).map(withProgress);
  res.json({ projects });
});

router.get('/:id', (req, res) => {
  const project = db.find('projects', req.params.id);
  if (!project || !visibleTo(req.user, project)) return res.status(404).json({ error: 'Project not found' });
  const tasks = db.filter('tasks', (t) => t.projectId === project.id);
  res.json({ project: withProgress(project), tasks });
});

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), (req, res) => {
  const { name, type, clientId, assignedPmId, status, description } = req.body || {};
  if (!name || !clientId) return res.status(400).json({ error: 'name and clientId are required' });
  const client = db.find('users', clientId);
  if (!client || client.role !== 'client') return res.status(400).json({ error: 'clientId must reference a client user' });

  const project = db.insert('projects', {
    name, type: type || 'General', clientId, assignedPmId: assignedPmId || null,
    status: status || 'On Track', description: description || '', createdAt: new Date().toISOString(),
  });
  audit(req.user.id, 'create', 'project', project.id);
  notify(clientId, `A new project was created for you: "${name}"`, 'project');
  if (assignedPmId) notify(assignedPmId, `You were assigned as PM on "${name}"`, 'project');
  res.status(201).json({ project: withProgress(project) });
});

router.put('/:id', requireCSRF, requireRole('admin', 'sales', 'project_manager'), (req, res) => {
  const project = db.find('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const patch = { ...req.body };
  delete patch.id;
  const updated = db.update('projects', req.params.id, patch);
  audit(req.user.id, 'update', 'project', req.params.id);

  if (patch.status && patch.status !== project.status) {
    notify(project.clientId, `Your project "${project.name}" moved to ${patch.status}`, 'project');
  }
  res.json({ project: withProgress(updated) });
});

router.delete('/:id', requireCSRF, requireRole('admin'), (req, res) => {
  const project = db.find('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const removedTasks = db.removeWhere('tasks', (t) => t.projectId === req.params.id);
  db.remove('projects', req.params.id);
  audit(req.user.id, 'delete', 'project', req.params.id, { removedTasks });
  res.json({ ok: true, removedTasks });
});

module.exports = router;
