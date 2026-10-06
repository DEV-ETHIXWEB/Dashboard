'use strict';

/**
 * "The thing you bought is now live" -- sent off the back of a project moving.
 *
 * The announcements themselves live in utils/serviceEmails.js. This file is the
 * only thing that decides when one is sent, and it exists because that decision
 * has three edges that are easy to get wrong:
 *
 * 1. It must happen once. A client who gets "your new website is live" twice
 *    stops believing the third one, and a project that is closed, reopened for
 *    a snag and closed again is an ordinary week. The guard is the email log,
 *    the same record slaWatch uses, plus a unique dedupe key on the queue so
 *    two requests landing in the same second cannot both win.
 *
 * 2. It must be deliberate. Only a project carrying a `service` key announces
 *    anything; an internal rebuild, a discovery piece or a project somebody
 *    created to track their own time all finish without mailing a soul.
 *
 * 3. It must never take the request down with it. A launch email failing is
 *    worth a line in the log; it is not worth refusing to save the project
 *    status the user just set. Every path here resolves rather than throws.
 */

const { db } = require('../db/setup');
const mailer = require('./mailer');
const service = require('./serviceEmails');

/**
 * The project statuses that mean "the client can see this now".
 *
 * Matched case-insensitively and against a set rather than one string, because
 * the status field is free text in practice: different corners of the app and
 * different admins have written Complete, Completed, Live and Launched for the
 * same event, and a launch email that fires for one spelling and not another is
 * worse than no automation at all.
 */
const LAUNCH_STATUSES = new Set(['complete', 'completed', 'live', 'launched', 'delivered']);

function isLaunched(status) {
  return LAUNCH_STATUSES.has(String(status || '').trim().toLowerCase());
}

/**
 * The extra detail an announcement reads better with.
 *
 * Stored as JSON on the project so an admin can fill in the domain, the budget
 * or the CRM name without this app needing a column per service. Anything
 * malformed is treated as absent: the templates all default gracefully, so a
 * broken blob costs a less specific email rather than no email.
 */
function parseContext(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * What the template is handed.
 *
 * The project's own fields win over the stored blob for the three things the
 * project already knows -- who the client is, who ran it, what it was called --
 * so those cannot drift out of date in a blob somebody filled in months ago.
 */
async function contextFor(project) {
  const [client, pm] = await Promise.all([
    project.clientId ? db.find('users', project.clientId) : null,
    project.assignedPmId ? db.find('users', project.assignedPmId) : null,
  ]);

  if (!client || !client.email) return null;

  return {
    client,
    context: {
      ...parseContext(project.serviceContext),
      clientName: client.name || null,
      ownerName: pm?.name || null,
      projectName: project.name || null,
    },
  };
}

/** Whether this exact announcement has already gone out for this project. */
async function alreadyAnnounced(template, projectId) {
  const rows = await db.filter(
    'email_log',
    (e) => e.template === template && e.entityId === projectId,
  );
  return rows.length > 0;
}

/**
 * Send one project's launch announcement.
 *
 * Returns what it did rather than throwing, so a caller can log it without a
 * try/catch of its own. `force` skips the already-sent check and is only for an
 * admin re-sending on purpose from the Mail page -- never for the status hook,
 * which is exactly the thing the check exists to protect against.
 */
async function announce(project, { force = false } = {}) {
  if (!project || !project.service) return { sent: false, reason: 'no service on this project' };

  const planned = service.launchFor(project.service);
  if (!planned) return { sent: false, reason: `unknown service "${project.service}"` };

  if (!force && (await alreadyAnnounced(planned.template, project.id))) {
    return { sent: false, reason: 'already announced', template: planned.template };
  }

  const resolved = await contextFor(project);
  if (!resolved) return { sent: false, reason: 'no client email on this project' };

  const built = service.launchFor(project.service, resolved.context);

  await mailer.sendTemplate({
    to: resolved.client.email,
    message: built.message,
    template: built.template,
    entity: 'project',
    entityId: project.id,
    // The unique index on this is the real guard. Two requests saving the same
    // status at the same moment both pass the log check above -- neither has
    // written a row yet -- and only one of them gets past this.
    dedupeKey: `launch:${built.template}:${project.id}`,
  });

  return { sent: true, template: built.template, to: resolved.client.email };
}

/**
 * The hook a project update calls after saving.
 *
 * Fires only on the crossing: a project that was already live and is saved
 * again announces nothing, which is what stops an edit to the description from
 * mailing the client a second launch notice.
 */
async function onStatusChange(project, fromStatus, toStatus) {
  if (!isLaunched(toStatus)) return { sent: false, reason: 'not a launch status' };
  if (isLaunched(fromStatus)) return { sent: false, reason: 'was already live' };
  return announce(project);
}

/**
 * The same hook, swallowed.
 *
 * What a route calls. The announcement is a courtesy on top of the save, and a
 * courtesy must never be the reason a save reports failure.
 */
async function announceQuietly(project, fromStatus, toStatus) {
  try {
    const result = await onStatusChange(project, fromStatus, toStatus);
    if (result.sent) {
      console.log(`Service launch email sent for project ${project.id}: ${result.template}`);
    }
    return result;
  } catch (err) {
    console.error(`Could not send the launch email for project ${project.id}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  LAUNCH_STATUSES,
  isLaunched,
  parseContext,
  announce,
  onStatusChange,
  announceQuietly,
};
