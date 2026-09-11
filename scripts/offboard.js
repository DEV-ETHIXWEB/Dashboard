#!/usr/bin/env node
'use strict';

/**
 * Remove people from the workspace when they leave the company.
 *
 * The in-app Team page can already do this, one person at a time, in two
 * clicks: step a super admin down, then delete them. This exists for the case
 * that shape does not fit -- several people leaving at once, and an operator
 * who would rather read what is about to happen than trust themselves to click
 * the right rows in production.
 *
 *   npm run offboard -- show one@example.com two@example.com
 *   npm run offboard -- remove one@example.com two@example.com --yes
 *
 * Two things it does that a careful human clicking through the UI can still
 * get wrong:
 *
 * The batch is checked as a whole before a single row is written. The API
 * refuses to remove the last super admin, but it can only see one request at a
 * time: delete two of the three super admins through the UI and the second
 * call is judged against a workspace the first call already changed. If the
 * batch would empty the roster, nothing here runs at all, rather than half of
 * it running and leaving the workspace in a state nobody chose.
 *
 * It withdraws the proposals they left behind. A departing admin's pending
 * approval requests are not touched by account deletion -- they sit in the
 * queue, attributed to an account that no longer exists, waiting for somebody
 * to approve a change the person who wanted it no longer works here.
 *
 * What it deliberately leaves alone: the audit log. Every action the person
 * took stays attributed to their id, which is the whole point of having one
 * when somebody leaves under a cloud. Deleting the account does not rewrite
 * the history of it.
 *
 * It does not touch Slack. Workspace membership and any threads they own there
 * are a separate system with separate credentials; revoke those in Slack.
 */

const { db, initSchema } = require('../db/setup');
const roles = require('../utils/roles');
const admins = require('../utils/admins');
const approvals = require('../utils/approvals');
const recoveryCodes = require('../utils/recoveryCodes');
const avatarStore = require('../utils/avatarStore');
const { audit } = require('../middleware/auth');

class OffboardError extends Error {}

/** One account, by email, case-insensitively. */
async function findByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  const matches = await db.filter('users', (u) => String(u.email).toLowerCase() === wanted);
  return matches[0] || null;
}

/**
 * What removing these accounts would do, without doing any of it.
 *
 * Throws rather than returning a half-answer: an operator running `show` on a
 * misspelled address should be told the address is wrong, not handed a plan
 * that quietly covers one fewer person than they asked for.
 */
async function plan(emails) {
  if (!emails.length) throw new OffboardError('Which accounts? Pass one or more email addresses.');

  const seen = new Set();
  const targets = [];
  for (const email of emails) {
    const key = String(email).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const user = await findByEmail(email);
    if (!user) throw new OffboardError(`No account found for ${email}. Nothing has been changed.`);
    targets.push(user);
  }

  const targetIds = new Set(targets.map((u) => u.id));
  const allAdmins = await roles.listAdmins();
  const remainingAdmins = allAdmins.filter((u) => !targetIds.has(u.id));
  const remainingSupers = remainingAdmins.filter(roles.isSuperAdmin);

  // Judged against the state after the whole batch, not after each step.
  if (allAdmins.length > 0 && remainingAdmins.length === 0) {
    throw new OffboardError(
      'That would remove every administrator. Promote someone else first. Nothing has been changed.',
    );
  }
  if (targets.some(roles.isSuperAdmin) && remainingSupers.length === 0) {
    throw new OffboardError(
      'That would remove every super admin, leaving nobody who can appoint one. '
      + 'Make someone else a super admin first. Nothing has been changed.',
    );
  }

  const details = [];
  for (const user of targets) {
    const pending = await db.filter(
      'approval_requests',
      (r) => r.requestedBy === user.id && r.status === 'pending',
    );
    const sessions = await db.filter('sessions', (s) => s.userId === user.id);
    const tasks = await db.filter('tasks', (t) => t.assigneeId === user.id);
    const tickets = await db.filter('tickets', (t) => t.assigneeId === user.id);
    const deliveries = await db.filter(
      'credential_deliveries',
      (r) => r.userId === user.id && (r.status === 'scheduled' || r.status === 'sending'),
    );
    details.push({
      user,
      wasSuperAdmin: roles.isSuperAdmin(user),
      pending: pending.length,
      sessions: sessions.length,
      tasks: tasks.length,
      tickets: tickets.length,
      deliveries: deliveries.length,
    });
  }

  return { details, remainingAdmins: remainingAdmins.length, remainingSupers: remainingSupers.length };
}

/**
 * Remove one account, in the order the API would.
 *
 * The step down from super admin is a write of its own rather than something
 * folded into the delete, so the audit log shows the same two events it would
 * have shown had somebody done this from the Team page. A single row appearing
 * from nowhere is harder to read a year later than two rows telling a story.
 */
async function removeOne(user, { reason = null } = {}) {
  const removed = {
    email: user.email,
    name: user.name,
    role: user.role,
    steppedDown: false,
    withdrawn: 0,
    sessions: 0,
    tasks: 0,
    tickets: 0,
    deliveries: 0,
    avatar: false,
  };

  const pending = await db.filter(
    'approval_requests',
    (r) => r.requestedBy === user.id && r.status === 'pending',
  );
  for (const row of pending) {
    // Their own proposals, withdrawn on their behalf -- `cancel` scrubs any
    // secret the payload was carrying, which a bare status update would leave
    // sitting in the table.
    await approvals.cancel(row.id, { id: user.id });
    removed.withdrawn += 1;
  }

  if (roles.isSuperAdmin(user)) {
    await db.update('users', user.id, {
      isSuperAdmin: false,
      adminTrusted: false,
      adminTrustedAt: null,
      adminTrustedBy: null,
    });
    await audit(null, 'standing', 'user', user.id, {
      isSuperAdmin: false,
      adminTrusted: false,
      via: 'offboard_script',
      reason: reason || null,
    });
    removed.steppedDown = true;
  }

  removed.sessions = (await db.filter('sessions', (s) => s.userId === user.id)).length;
  await db.removeWhere('sessions', (s) => s.userId === user.id);
  await db.removeWhere('otp_codes', (o) => o.userId === user.id);
  await recoveryCodes.clearFor(user.id);

  // Every other way back in. None of these can actually be redeemed once the
  // account is gone -- each consumption path re-reads the user and refuses a
  // missing one -- but a token table is not the place to keep a departed
  // employee's name, and "it fails safely" is a worse answer than "it is not
  // there". The delete route leaves all of these behind; this does not.
  await db.removeWhere('login_links', (r) => r.userId === user.id);
  await db.removeWhere('password_tokens', (r) => r.userId === user.id);

  // A delivery still queued would wake up, find no account, and cancel itself.
  // Cancelling it here says who stopped it and why, rather than leaving a row
  // that looks like it failed.
  const openDeliveries = await db.filter(
    'credential_deliveries',
    (r) => r.userId === user.id && (r.status === 'scheduled' || r.status === 'sending'),
  );
  for (const d of openDeliveries) {
    await db.update('credential_deliveries', d.id, {
      status: 'cancelled',
      cancelledAt: Date.now(),
      lastError: 'The account was removed.',
      updatedAt: new Date().toISOString(),
    });
    removed.deliveries += 1;
  }

  // Their picture, through the store rather than the table, so the bytes go
  // too whether they live on disk or somewhere else.
  try {
    removed.avatar = Boolean(await avatarStore.remove(user.id));
  } catch (err) {
    // Never worth failing an offboarding over; the account still goes.
    console.warn(`  (could not remove the avatar for ${user.email}: ${err.message})`);
  }

  await db.removeWhere('ticket_collaborators', (r) => r.userId === user.id);

  const tasks = await db.filter('tasks', (t) => t.assigneeId === user.id);
  for (const t of tasks) await db.update('tasks', t.id, { assigneeId: null });
  removed.tasks = tasks.length;

  const tickets = await db.filter('tickets', (t) => t.assigneeId === user.id);
  for (const t of tickets) await db.update('tickets', t.id, { assigneeId: null });
  removed.tickets = tickets.length;

  // Notifications addressed to an account that no longer exists are unreadable
  // by anyone; the delete route leaves them, this does not.
  await db.removeWhere('notifications', (n) => n.userId === user.id);

  const ok = await db.remove('users', user.id);
  if (!ok) throw new OffboardError(`Could not delete ${user.email}; the account may have just been removed.`);

  await audit(null, 'delete', 'user', user.id, {
    email: user.email,
    role: user.role,
    via: 'offboard_script',
    reason: reason || null,
  });

  return removed;
}

/** Run the whole batch, having already established that it is safe to. */
async function offboard(emails, { reason = null } = {}) {
  const { details } = await plan(emails);
  const results = [];
  for (const d of details) results.push(await removeOne(d.user, { reason }));

  const names = results.map((r) => `${r.name} <${r.email}>`).join(', ');
  await admins.notifyAdmins(
    `${names} ${results.length === 1 ? 'was' : 'were'} removed from the workspace from the server console`
      + `${reason ? ` (${reason})` : ''}. Sign-in access ended immediately.`,
    'admin',
  );

  return results;
}

// --- the command line ------------------------------------------------------

function usage() {
  return [
    'Remove accounts when somebody leaves the company.',
    '',
    'Usage:',
    '  npm run offboard -- show <email> [<email>...]',
    '  npm run offboard -- remove <email> [<email>...] [--reason "..."] --yes',
    '',
    'Options:',
    '  --yes             Actually do it. Without this, remove only shows what would happen.',
    '  --reason "..."    Recorded in the audit log and in the alert to the remaining admins.',
    '',
    'A super admin is stepped down automatically before being deleted. The batch is',
    'refused outright if it would leave the workspace with no admin, or with no super',
    'admin -- nothing is written in that case, not even the part that would have been',
    'allowed.',
    '',
    'This does not touch Slack. Revoke workspace membership there separately.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { command: argv[0] || 'help', emails: [], reason: null, confirmed: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') args.confirmed = true;
    else if (arg === '--reason') args.reason = argv[++i] || null;
    else if (!arg.startsWith('-')) args.emails.push(arg);
  }
  return args;
}

function describe({ details, remainingAdmins, remainingSupers }) {
  const lines = ['Nothing has been changed. This is what would happen:', ''];
  for (const d of details) {
    const standing = d.wasSuperAdmin
      ? 'super admin'
      : roles.isTrustedAdmin(d.user) ? 'trusted admin' : d.user.role;
    lines.push(`  ${d.user.name} <${d.user.email}> -- ${standing}`);
    lines.push(d.wasSuperAdmin ? '      stepped down from super admin, then deleted' : '      deleted');
    lines.push(`      ${d.sessions} active session${d.sessions === 1 ? '' : 's'} ended, backup and sign-in codes cleared`);
    lines.push('      login links, password-reset tokens and profile picture removed');
    if (d.deliveries) {
      lines.push(`      ${d.deliveries} queued credential deliver${d.deliveries === 1 ? 'y' : 'ies'} cancelled`);
    }
    if (d.pending) {
      lines.push(`      ${d.pending} pending approval request${d.pending === 1 ? '' : 's'} withdrawn`);
    }
    if (d.tasks || d.tickets) {
      lines.push(`      ${d.tasks} task${d.tasks === 1 ? '' : 's'} and ${d.tickets} ticket${d.tickets === 1 ? '' : 's'} left unassigned`);
    }
    lines.push('');
  }
  lines.push(`  Afterwards  ${remainingAdmins} administrator${remainingAdmins === 1 ? '' : 's'}, ${remainingSupers} of them super`);
  lines.push('  Kept        every audit log entry, still attributed to them');
  lines.push('  Recorded    audit log entries, and an in-app alert to the remaining admins');
  lines.push('');
  lines.push('Re-run with --yes to go ahead. There is no undo.');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(usage());
    return 0;
  }

  if (args.command !== 'show' && args.command !== 'remove') {
    console.error(`Unknown command: ${args.command}\n`);
    console.error(usage());
    return 1;
  }

  await initSchema();

  if (!args.emails.length) {
    console.error('Which accounts? Pass one or more email addresses.\n');
    console.error(usage());
    return 1;
  }

  if (args.command === 'show' || !args.confirmed) {
    console.log(describe(await plan(args.emails)));
    return 0;
  }

  const results = await offboard(args.emails, { reason: args.reason });

  console.log('');
  for (const r of results) {
    console.log(`Removed ${r.name} <${r.email}> (${r.role})`);
    if (r.steppedDown) console.log('  stepped down from super admin first');
    console.log(`  ${r.sessions} session${r.sessions === 1 ? '' : 's'} ended, backup and sign-in codes cleared`);
    console.log('  login links and password-reset tokens removed');
    if (r.deliveries) console.log(`  ${r.deliveries} queued credential deliver${r.deliveries === 1 ? 'y' : 'ies'} cancelled`);
    if (r.avatar) console.log('  profile picture deleted');
    if (r.withdrawn) console.log(`  ${r.withdrawn} pending approval request${r.withdrawn === 1 ? '' : 's'} withdrawn`);
    if (r.tasks || r.tickets) {
      console.log(`  ${r.tasks} task${r.tasks === 1 ? '' : 's'} and ${r.tickets} ticket${r.tickets === 1 ? '' : 's'} left unassigned`);
    }
  }
  console.log('');
  console.log('Their sign-in access ended the moment the sessions went.');
  console.log('This has been written to the audit log and announced to the remaining administrators.');
  console.log('');
  console.log('Still to do by hand: revoke their Slack workspace membership, and clear');
  console.log('SUPER_ADMIN_EMAIL from the environment if it names one of them.');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof OffboardError || err instanceof admins.AdminError) {
        console.error(err.message);
        process.exit(1);
      }
      console.error('Could not complete the offboarding:', err.message);
      process.exit(1);
    });
}

module.exports = { main, plan, offboard, removeOne, findByEmail, parseArgs, usage, OffboardError };
