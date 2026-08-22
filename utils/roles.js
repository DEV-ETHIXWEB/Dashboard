'use strict';

/**
 * Who is allowed to do what, in one place.
 *
 * The central decision: a super admin is **not a sixth role**. They are an
 * admin carrying a flag. Every `requireRole('admin')` and every
 * `role === 'admin'` already written in this app therefore grants them access
 * without being touched, which means a super admin cannot silently lose a
 * permission because somebody forgot to add a role to a list. Only the two
 * powers that are genuinely exclusive read the flag.
 *
 * The three states an administrator can be in:
 *
 *   super       appoints admins, vouches for them, acts alone, reads the log
 *   trusted     acts alone
 *   untrusted   proposes; a sensitive change waits for a second signature
 *
 * A new admin starts untrusted. That is the whole point: the account that was
 * created five minutes ago is the one worth a second pair of eyes.
 */

const { db } = require('../db/setup');

/** Postgres returns booleans, Firestore may return strings. Normalise both. */
function flag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isAdmin(user) {
  return user?.role === 'admin';
}

function isSuperAdmin(user) {
  return isAdmin(user) && flag(user.isSuperAdmin);
}

/** An admin who has been vouched for, or who never needed vouching. */
function isTrustedAdmin(user) {
  return isSuperAdmin(user) || (isAdmin(user) && flag(user.adminTrusted));
}

/**
 * Whether this person's sensitive changes are held for a second signature.
 *
 * Only administrators are ever held. Everyone else is already limited by their
 * role: a project manager cannot reach these operations at all, so routing
 * them through an approval queue would be theatre.
 */
function needsApproval(user) {
  return isAdmin(user) && !isTrustedAdmin(user);
}

/** Appointing or removing an administrator is a super admin's call alone. */
function canManageAdmins(user) {
  return isSuperAdmin(user);
}

/** The audit log is the super admin's window on everyone else, including admins. */
function canReadAuditLog(user) {
  return isSuperAdmin(user);
}

/**
 * Who may sign off someone else's proposal.
 *
 * A super admin, or an admin who has been vouched for. An untrusted admin
 * cannot approve, or two fresh accounts could wave each other through.
 */
function canDecideApprovals(user) {
  return isTrustedAdmin(user);
}

async function listAdmins() {
  return db.filter('users', (u) => u.role === 'admin');
}

async function listSuperAdmins() {
  return (await listAdmins()).filter(isSuperAdmin);
}

/** Everyone entitled to sign off a proposal, minus whoever raised it. */
async function listApprovers({ exceptUserId = null } = {}) {
  const admins = await listAdmins();
  return admins.filter((u) => canDecideApprovals(u) && u.id !== exceptUserId);
}

/**
 * The shape the browser reads. Kept next to the rules it describes so the two
 * cannot drift: the UI hides what these say to hide, and the server refuses it
 * again regardless.
 */
function capabilitiesFor(user) {
  return {
    isSuperAdmin: isSuperAdmin(user),
    isTrustedAdmin: isTrustedAdmin(user),
    needsApproval: needsApproval(user),
    canManageAdmins: canManageAdmins(user),
    canReadAuditLog: canReadAuditLog(user),
    canDecideApprovals: canDecideApprovals(user),
  };
}

/**
 * A workspace must always have exactly one thing: someone who can appoint
 * admins. Called at boot, after seeding.
 *
 * SUPER_ADMIN_EMAIL names the account when it is set. Otherwise the
 * longest-standing admin is promoted, so an existing deployment gains a super
 * admin on the next boot without anyone having to run a script.
 */
async function ensureSuperAdmin() {
  const admins = await listAdmins();
  if (admins.length === 0) return null;
  if (admins.some(isSuperAdmin)) return null;

  const wanted = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const chosen = (wanted && admins.find((u) => String(u.email).toLowerCase() === wanted))
    || admins.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];

  if (!chosen) return null;
  await db.update('users', chosen.id, {
    isSuperAdmin: true,
    adminTrusted: true,
    adminTrustedAt: new Date().toISOString(),
    adminTrustedBy: 'system',
  });
  console.log(`[roles] ${chosen.email} is the super admin for this workspace.`);
  return chosen.id;
}

module.exports = {
  flag,
  isAdmin,
  isSuperAdmin,
  isTrustedAdmin,
  needsApproval,
  canManageAdmins,
  canReadAuditLog,
  canDecideApprovals,
  listAdmins,
  listSuperAdmins,
  listApprovers,
  capabilitiesFor,
  ensureSuperAdmin,
};
