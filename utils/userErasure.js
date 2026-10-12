'use strict';

/**
 * Deleting an account, and everything that belonged to it.
 *
 * There were two ways to delete a user and they did different amounts of work.
 * The direct route removed the row, the sessions, the sign-in codes and the
 * recovery codes, and unassigned their tasks and tickets. The approval queue
 * removed the row and nothing else -- so an account deleted by the path that
 * exists *because* the action is sensitive left live sessions behind, and
 * whoever held one stayed signed in as a user who no longer existed.
 *
 * Both paths now call this. One routine, so there is one answer to "what does
 * deleting an account actually do" instead of two that disagree.
 *
 * It is also more thorough than either was, because the Privacy page promises
 * deletion on request and that promise covers more than a row in `users`:
 * login links, password tokens, the avatar, notifications, membership history,
 * the funnel events, held requests, and the usage counters. Each of those is
 * personal data keyed to a person, and none of it was being removed.
 *
 * What is deliberately kept:
 *
 *   activity_log     the audit trail. It is how an administrator answers "who
 *                    deleted this account and when", and an audit log you can
 *                    erase by deleting the subject is not an audit log. It
 *                    holds ids and actions, not personal detail.
 *   tickets          the work itself, and its history with the team. The
 *                    client_id is cleared on a client's tickets so they stop
 *                    being attributable, and the assignee is cleared on a
 *                    staff member's so they go back in the queue.
 *   payments/billing the financial record, which there are statutory reasons
 *                    to keep. The Stripe customer is a separate decision for
 *                    whoever runs that account.
 */

const { db } = require('../db/setup');

/**
 * Remove every row keyed to this user in a collection, by a named field.
 *
 * Best-effort per collection: a table that does not exist on this deployment,
 * or a driver that refuses one query, must not stop the rest of the erasure.
 * Half-deleted is bad; not-deleted-at-all because of one missing table is
 * worse.
 */
async function removeBy(collection, field, userId) {
  try {
    return await db.removeWhere(collection, (row) => row[field] === userId);
  } catch (err) {
    console.error(`[erase] could not clear ${collection}.${field} for ${userId}: ${err.message}`);
    return 0;
  }
}

/** Blank a field on every row that points at this user, rather than deleting. */
async function detach(collection, field, userId) {
  try {
    const rows = await db.filter(collection, (row) => row[field] === userId);
    for (const row of rows) await db.update(collection, row.id, { [field]: null });
    return rows.length;
  } catch (err) {
    console.error(`[erase] could not detach ${collection}.${field} for ${userId}: ${err.message}`);
    return 0;
  }
}

/**
 * Delete the account and erase what belonged to it.
 *
 * Returns a summary of what was removed, which the caller writes to the audit
 * log -- "deleted an account" is not a useful record of an irreversible act,
 * and the counts are what makes it one.
 *
 * The `users` row goes last. Everything before it is cleanup; if the process
 * dies partway through, the account still exists and the operation can be
 * repeated, which is the recoverable order.
 */
async function eraseUser(userId) {
  const user = await db.find('users', userId);
  if (!user) return null;

  const removed = {};

  // --- the ways back in ----------------------------------------------------
  // Sessions first, always: while any of these live, somebody is still signed
  // in as this account.
  removed.sessions = await removeBy('sessions', 'userId', userId);
  removed.otpCodes = await removeBy('otp_codes', 'userId', userId);
  removed.loginLinks = await removeBy('login_links', 'userId', userId);
  removed.passwordTokens = await removeBy('password_tokens', 'userId', userId);
  removed.credentialDeliveries = await removeBy('credential_deliveries', 'userId', userId);

  try {
    await require('./recoveryCodes').clearFor(userId);
    removed.recoveryCodes = true;
  } catch (err) {
    console.error(`[erase] could not clear recovery codes for ${userId}: ${err.message}`);
  }

  // --- personal data -------------------------------------------------------
  removed.avatar = await removeBy('user_avatars', 'userId', userId);
  removed.notifications = await removeBy('notifications', 'userId', userId);

  // A client's membership history, the funnel trail behind it, anything they
  // were holding, and the allowance counters. All keyed to the person.
  removed.subscriptions = await removeBy('subscriptions', 'clientId', userId);
  removed.membershipEvents = await removeBy('membership_events', 'clientId', userId);
  removed.queuedRequests = await removeBy('queued_requests', 'clientId', userId);
  removed.usageCounters = await removeBy('update_request_usage', 'clientId', userId);
  removed.siteRecords = await removeBy('site_records', 'clientId', userId);
  removed.budgetItems = await removeBy('budget_items', 'clientId', userId);

  // Texts to and from this person, and the conversation that grouped them.
  removed.smsMessages = await removeBy('sms_messages', 'clientId', userId);
  removed.smsConversations = await removeBy('sms_conversations', 'clientId', userId);

  // --- work that outlives them ---------------------------------------------
  // Kept, but no longer attributable. A ticket is the team's record of a job;
  // deleting it would take a colleague's history with it.
  removed.ticketsUnassigned = await detach('tickets', 'assigneeId', userId);
  removed.ticketsOrphaned = await detach('tickets', 'clientId', userId);
  removed.tasksUnassigned = await detach('tasks', 'assigneeId', userId);
  removed.projectsUnassigned = await detach('projects', 'assignedPmId', userId);
  removed.projectsOrphaned = await detach('projects', 'clientId', userId);
  removed.ticketCollaborations = await removeBy('ticket_collaborators', 'userId', userId);

  // Their documents, including the files behind them. See routes/reports.js:
  // a row deleted without its Drive file leaves the document in place.
  try {
    const reports = await db.filter('reports', (r) => r.clientId === userId);
    const drive = require('./googleDrive');
    for (const report of reports) {
      if (report.storageType === 'drive' && report.driveFileId) {
        await drive.deleteFromDrive(report.driveFileId);
      }
      await db.remove('reports', report.id);
    }
    removed.reports = reports.length;
  } catch (err) {
    console.error(`[erase] could not clear documents for ${userId}: ${err.message}`);
  }

  removed.domains = await removeBy('domains', 'clientId', userId);

  // --- and the account itself ----------------------------------------------
  removed.user = await db.remove('users', userId);

  return { user, removed };
}

module.exports = { eraseUser };
