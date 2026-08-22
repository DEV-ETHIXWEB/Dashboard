'use strict';

/**
 * The workspace has a set of administrators, not an owner.
 *
 * Every admin has identical powers, so anything aimed at "the admin" has to
 * reach all of them: in-app bells, alert email, and roster changes. The only
 * rule the app enforces is that the last administrator cannot be removed or
 * demoted, because that would lock everyone out of user management for good.
 */

const { db } = require('../db/setup');
const { v4: uuidv4 } = require('uuid');
const mailer = require('./mailer');

class AdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

async function listAdmins() {
  return db.filter('users', (u) => u.role === 'admin');
}

async function countAdmins() {
  return (await listAdmins()).length;
}

/**
 * Where "tell the admins" email goes: every admin account with a usable
 * address, plus the standing ADMIN_ALERT_EMAILS inboxes.
 */
async function adminEmails({ extra = [], exclude = [] } = {}) {
  const admins = await listAdmins();
  const excluded = new Set(exclude.filter(Boolean).map((e) => String(e).toLowerCase()));
  const all = [
    ...admins.map((u) => u.email),
    ...mailer.adminRecipients(),
    ...extra,
  ];
  return mailer.cleanRecipients(all).filter((e) => !excluded.has(e.toLowerCase()));
}

/** In-app bell for every admin. `exceptUserId` skips whoever caused the event. */
async function notifyAdmins(message, type = 'general', { exceptUserId = null } = {}) {
  const admins = await listAdmins();
  for (const admin of admins) {
    if (exceptUserId && admin.id === exceptUserId) continue;
    await db.insert('notifications', {
      id: uuidv4(),
      userId: admin.id,
      message,
      type,
      read: false,
      createdAt: new Date().toISOString(),
    });
  }
  return admins.length;
}

/**
 * Guard for the two operations that can empty the roster. Call it *before*
 * writing, and let the route turn AdminError into its status.
 */
async function assertRosterSurvives(userId, { nextRole = null } = {}) {
  const target = await db.find('users', userId);
  if (!target || target.role !== 'admin') return;
  // Demotion to admin is a no-op; only a move away from admin matters.
  if (nextRole === 'admin') return;
  const remaining = (await listAdmins()).filter((u) => u.id !== userId);
  if (remaining.length === 0) {
    throw new AdminError(
      nextRole
        ? 'This is the only administrator left. Promote someone else first, then change this role.'
        : 'This is the only administrator left. Promote someone else before deleting this account.',
      409,
    );
  }
}

module.exports = {
  AdminError,
  listAdmins,
  countAdmins,
  adminEmails,
  notifyAdmins,
  assertRosterSurvives,
};
