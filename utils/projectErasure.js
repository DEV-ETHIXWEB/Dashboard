'use strict';

/**
 * Deleting a project, and the things that only existed because of it.
 *
 * Both paths to this -- the route and the approval queue -- removed the
 * project row and its tasks, and nothing else. What stayed behind:
 *
 *   ClickUp tasks    the mirrors of the tasks that were just deleted. The
 *                    board kept showing work for a project that no longer
 *                    exists, which is the failure that makes a team stop
 *                    trusting the board.
 *   ticket links     tickets pointing at the project, left pointing at
 *                    nothing.
 *
 * What is deliberately kept, and why, because "delete the project" reads as
 * though it should take more with it than it does:
 *
 *   reports     a client's documents are theirs, and are filed under the
 *               client, not the project. A contract does not stop existing
 *               because the job it describes was closed.
 *   domains     a website outlives the project that built it. Deleting the
 *               project would otherwise take the client's hosting record with
 *               it, which is the opposite of what anybody means.
 *   budget      the money is the client's record of what they spent. It is
 *               still true after the work is finished.
 *
 * Those three are the ones the audit flagged as "left behind"; the answer is
 * that they belong to the client rather than to the project, and deleting them
 * here would be destroying a record nobody asked to destroy. Written down so
 * the next person does not have to re-derive it.
 */

const { db } = require('../db/setup');

/**
 * Remove a project, its tasks, and their mirrors.
 *
 * Returns what was removed so the caller can put it in the audit entry --
 * "deleted a project" is a poor record of an irreversible act, and the counts
 * are what make it a real one.
 */
async function eraseProject(projectId) {
  const project = await db.find('projects', projectId);
  if (!project) return null;

  const tasks = await db.where('tasks', { projectId });

  /**
   * The ClickUp mirrors first, while we still know their ids.
   *
   * Best-effort and individually caught: ClickUp being unreachable must not
   * stop a deletion the user asked for, and a mirror that is already gone is
   * the outcome we wanted. A board left showing tasks for a deleted project is
   * worse than a board missing one.
   */
  let mirrorsRemoved = 0;
  const clickup = require('./clickup');
  for (const task of tasks) {
    if (!task.clickupTaskId) continue;
    try {
      await clickup.deleteMirroredTask(task.clickupTaskId);
      mirrorsRemoved += 1;
    } catch (err) {
      console.error(`[projects] could not remove the ClickUp mirror for ${task.id}: ${err.message}`);
    }
  }

  const removedTasks = await db.removeWhere('tasks', (t) => t.projectId === projectId);

  // Tickets outlive the project -- they are the client's conversation with the
  // team -- but they stop pointing at something that is not there.
  let ticketsDetached = 0;
  try {
    const linked = await db.filter('tickets', (t) => t.projectId === projectId);
    for (const ticket of linked) {
      await db.update('tickets', ticket.id, { projectId: null });
      ticketsDetached += 1;
    }
  } catch {
    // `tickets` has no project_id on every deployment. Nothing to detach.
  }

  await db.remove('projects', projectId);

  return { project, removed: { removedTasks, mirrorsRemoved, ticketsDetached } };
}

module.exports = { eraseProject };
