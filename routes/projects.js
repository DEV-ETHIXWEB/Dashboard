'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const { requirePage } = require('../utils/clientPages');
const approvals = require('../utils/approvals');

const STATUS_PCT = { 'To Do': 0, 'In Progress': 50, 'In Review': 90, Complete: 100 };

router.use(requireAuth);
router.use(requirePage('projects'));

function progressFor(project, tasks) {
  const total = tasks.length;
  const complete = tasks.filter((t) => t.status === 'Complete').length;
  const pct = total === 0 ? 0 : Math.round(tasks.reduce((sum, t) => sum + (STATUS_PCT[t.status] ?? 0), 0) / total);
  return { ...project, progress: { pct, complete, total } };
}

function visibleTo(user, project, tasksByProject) {
  if (user.role === 'admin' || user.role === 'sales' || user.role === 'project_manager') return true;
  if (user.role === 'client') return project.clientId === user.id;
  if (user.role === 'employee') {
    const tasks = tasksByProject.get(project.id) || [];
    return tasks.some((t) => t.assigneeId === user.id);
  }
  return false;
}

/**
 * One read of the tasks table, grouped by project, instead of a query per
 * project -- a workspace with N projects used to run up to 2N full scans of
 * tasks just to render the list.
 */
function groupTasksByProject(tasks) {
  const byProject = new Map();
  for (const t of tasks) {
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId).push(t);
  }
  return byProject;
}

router.get('/', async (req, res, next) => {
  try {
    const [all, tasks] = await Promise.all([db.all('projects'), db.all('tasks')]);
    const tasksByProject = groupTasksByProject(tasks);
    const visible = all.filter((p) => visibleTo(req.user, p, tasksByProject));
    const withProgressList = visible.map((p) => progressFor(p, tasksByProject.get(p.id) || []));
    res.json({ projects: withProgressList });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await db.find('projects', req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const tasks = await db.filter('tasks', (t) => t.projectId === project.id);
    if (!visibleTo(req.user, project, new Map([[project.id, tasks]]))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({ project: progressFor(project, tasks), tasks });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const { name, type, clientId, assignedPmId, status, description } = req.body || {};
    if (!name || !clientId) return res.status(400).json({ error: 'name and clientId are required' });
    const client = await db.find('users', clientId);
    if (!client || client.role !== 'client') return res.status(400).json({ error: 'clientId must reference a client user' });

    const project = await db.insert('projects', {
      name, type: type || 'General', clientId, assignedPmId: assignedPmId || null,
      status: status || 'On Track', description: description || '', createdAt: new Date().toISOString(),
    });
    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [clientId];
    await audit(req.user.id, 'create', 'project', project.id);
    await notify(clientId, `A new project was created for you: "${name}"`, 'project');
    if (assignedPmId) await notify(assignedPmId, `You were assigned as PM on "${name}"`, 'project');
    res.status(201).json({ project: progressFor(project, []) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireCSRF, requireRole('admin', 'sales', 'project_manager'), async (req, res, next) => {
  try {
    const project = await db.find('projects', req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const patch = { ...req.body };
    delete patch.id;

    // Which client a project belongs to decides whose portal shows it, so a
    // change of owner is checked rather than taken on trust -- pointing a
    // project at a staff id, or at nothing, puts it somewhere nobody expects.
    const movingClient = 'clientId' in patch && patch.clientId !== project.clientId;
    if (movingClient) {
      const nextClient = await db.find('users', patch.clientId);
      if (!nextClient || nextClient.role !== 'client') {
        return res.status(400).json({ error: 'That is not a client account.' });
      }
    }

    const updated = await db.update('projects', req.params.id, patch);
    // Tell this client's open tabs, not everyone's -- both sides when it moved.
    res.locals.liveAudience = [...new Set([project.clientId, updated.clientId].filter(Boolean))];
    await audit(req.user.id, 'update', 'project', req.params.id, {
      changed: Object.keys(patch),
      ...(movingClient ? { clientFrom: project.clientId, clientTo: updated.clientId } : {}),
    });

    if (patch.status && patch.status !== project.status) {
      await notify(project.clientId, `Your project "${project.name}" moved to ${patch.status}`, 'project');
    }
    const tasks = await db.filter('tasks', (t) => t.projectId === req.params.id);
    res.json({ project: progressFor(updated, tasks) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const project = await db.find('projects', req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const gate = await approvals.gate(req, res, {
      action: 'project.delete',
      summary: `Delete the project "${project.name}" and every task on it`,
      payload: { projectId: req.params.id },
    });
    if (gate.held) return;

    // Tell this client's open tabs, not everyone's.
    res.locals.liveAudience = [project.clientId];
    const removedTasks = await db.removeWhere('tasks', (t) => t.projectId === req.params.id);
    await db.remove('projects', req.params.id);
    await audit(req.user.id, 'delete', 'project', req.params.id, { removedTasks });
    res.json({ ok: true, removedTasks });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
