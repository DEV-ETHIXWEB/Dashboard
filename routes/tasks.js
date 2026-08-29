'use strict';

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireRole, requireCSRF, audit, notify } = require('../middleware/auth');
const slack = require('../utils/slack');
const clickup = require('../utils/clickup');

router.use(requireAuth);

/** Roles a task can be given to. */
const ASSIGNEE_ROLES = ['admin', 'project_manager', 'employee'];

/**
 * Whether an id may be written into `assigneeId`.
 *
 * Nothing checked this before, so a client id could be written into the field
 * the board reads to decide who is doing the work -- and that person would
 * then be notified about it. Null is allowed and means unassigned.
 */
async function isValidAssignee(id) {
  if (!id) return true;
  const user = await db.find('users', id);
  return Boolean(user) && ASSIGNEE_ROLES.includes(user.role);
}

/** The assignee's email, which is the only handle ClickUp and this app share. */
async function assigneeEmail(assigneeId) {
  if (!assigneeId) return null;
  const user = await db.find('users', assigneeId);
  return user?.email || null;
}

/**
 * Start the task in ClickUp and remember where it landed.
 *
 * Best-effort throughout, exactly like ticket mirroring in utils/ticketIntake:
 * the task is already saved here, and ClickUp being unreachable must never be
 * the reason a task cannot be created. Returns the row to send back -- updated
 * with the ClickUp ids when the mirror worked, untouched when it did not.
 */
async function mirrorNewTask(task, project) {
  if (!clickup.isTaskMirroringEnabled()) return task;
  try {
    const mirrored = await clickup.mirrorTask(task, {
      projectName: project?.name,
      assigneeEmail: await assigneeEmail(task.assigneeId),
    });
    if (!mirrored) return task;
    return db.update('tasks', task.id, {
      clickupTaskId: mirrored.id,
      clickupTaskUrl: mirrored.url,
    });
  } catch (err) {
    console.error(`Could not create task ${task.id} in ClickUp:`, err.message);
    return task;
  }
}

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
    if (!(await isValidAssignee(assigneeId))) {
      return res.status(400).json({ error: 'A task can only be assigned to a member of the team.' });
    }

    const saved = await db.insert('tasks', {
      projectId, name, assigneeId: assigneeId || null, status: 'To Do',
      priority: priority || 'Medium', due: due || null,
      clickupTaskId: null, clickupTaskUrl: null,
    });
    await audit(req.user.id, 'create', 'task', saved.id);
    if (assigneeId) await notify(assigneeId, `You were assigned a new task: "${name}"`, 'task');
    slack.notifySlack(`📝 *New Task Created:* "${name}" (Project: ${project.name}, Priority: ${priority || 'Medium'})`);

    const task = await mirrorNewTask(saved, project);
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
    // The mirror's ids are ours to write, not the caller's.
    delete patch.clickupTaskId;
    delete patch.clickupTaskUrl;

    if ('assigneeId' in patch && !(await isValidAssignee(patch.assigneeId))) {
      return res.status(400).json({ error: 'A task can only be assigned to a member of the team.' });
    }

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

    // Carry the edit over to ClickUp. Mirroring only creation would let the two
    // boards disagree within a day, at which point nobody trusts either.
    if (updated.clickupTaskId) {
      try {
        await clickup.updateMirroredTask(updated.clickupTaskId, patch, {
          assigneeEmail: await assigneeEmail(updated.assigneeId),
        });
      } catch (err) {
        console.error(`Could not update task ${req.params.id} in ClickUp:`, err.message);
      }
    }
    res.json({ task: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireCSRF, requireRole('admin', 'project_manager'), async (req, res, next) => {
  try {
    // Read it first: once the row is gone there is no way to find the mirror
    // it left behind in ClickUp.
    const existing = await db.find('tasks', req.params.id);
    const ok = await db.remove('tasks', req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    await audit(req.user.id, 'delete', 'task', req.params.id);

    if (existing?.clickupTaskId) {
      try {
        await clickup.deleteMirroredTask(existing.clickupTaskId);
      } catch (err) {
        console.error(`Could not delete task ${req.params.id} in ClickUp:`, err.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
