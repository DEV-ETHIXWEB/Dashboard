#!/usr/bin/env node
'use strict';

/**
 * Break-glass: get an administrator back into a workspace from the server.
 *
 * Administrators sign in with a password and a code, and hold backup codes for
 * when the code cannot reach them. That covers every case except the first one:
 * a deployment where no administrator has ever signed in has nobody holding a
 * backup code, and no way to generate one, because generating one requires
 * being signed in. If mail is not working on that deployment, the front door is
 * shut with everybody outside it.
 *
 * This closes that. Run on the server, it issues a fresh set of backup codes
 * for one named administrator and prints them once.
 *
 *   npm run admin:recovery -- list
 *   npm run admin:recovery -- issue admin@example.com --yes
 *
 * It grants no power that server access did not already carry -- anyone who can
 * run this can already reach the database and rewrite a password hash directly.
 * What it adds is a supported way to do it that leaves a record: the action is
 * written to the audit log and announced in-app to every other administrator,
 * which a hand-edited database row would not be.
 *
 * Two things it deliberately will not do. It never prints or changes a
 * password, and it refuses any account that is not an administrator -- a client
 * or staff member locked out has an admin to help them, which is a different
 * and much smaller problem.
 */

const { db, initSchema } = require('../db/setup');
const recoveryCodes = require('../utils/recoveryCodes');
const roles = require('../utils/roles');
const admins = require('../utils/admins');
const { audit } = require('../middleware/auth');

class RecoveryError extends Error {}

/** Every administrator, with how many backup codes each is holding. */
async function listAdmins() {
  const rows = await db.filter('users', (u) => u.role === 'admin');
  const out = [];
  for (const admin of rows) {
    const status = await recoveryCodes.statusFor(admin.id);
    out.push({
      id: admin.id,
      name: admin.name,
      email: admin.email,
      isSuperAdmin: roles.isSuperAdmin(admin),
      trusted: roles.isTrustedAdmin(admin),
      remaining: status.remaining,
      total: status.total,
    });
  }
  return out.sort((a, b) => Number(b.isSuperAdmin) - Number(a.isSuperAdmin));
}

/**
 * Issue a fresh set for one administrator.
 *
 * Replaces whatever they were holding, the same as the in-app button does --
 * an old list that may or may not still exist somewhere is not something to
 * leave live alongside a new one.
 */
async function issueFor(email, { reason = null } = {}) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) throw new RecoveryError('An email address is required.');

  const matches = await db.filter('users', (u) => String(u.email).toLowerCase() === wanted);
  const user = matches[0];
  if (!user) throw new RecoveryError(`No account found for ${email}.`);
  if (user.role !== 'admin') {
    throw new RecoveryError(
      `${user.name} is a ${user.role}, not an administrator. Backup codes are for administrator accounts; `
      + 'a locked-out client or staff member should ask an admin instead.',
    );
  }

  const before = await recoveryCodes.statusFor(user.id);
  const codes = await recoveryCodes.issueFor(user.id);

  // On the record, both ways. A break-glass action nobody can see afterwards is
  // indistinguishable from somebody quietly helping themselves to an account.
  await audit(null, 'recovery_codes', 'user', user.id, {
    action: 'issued_from_server',
    count: codes.length,
    replaced: before.total,
    reason: reason || null,
  });
  await admins.notifyAdmins(
    `Backup sign-in codes were issued for ${user.name} from the server console`
      + `${reason ? ` (${reason})` : ''}. If this was not expected, treat it as a security event.`,
    'security',
    { exceptUserId: user.id },
  );

  return { user, codes, replaced: before.total };
}

/**
 * Make an administrator a super admin, from the server.
 *
 * The same gap as the backup codes above, one level up. Appointing a super
 * admin is a super admin's call, which is fine until the only one is
 * unreachable -- they have left, or the account was always somebody's personal
 * address and nobody else can sign into it. At that point the workspace cannot
 * appoint admins, read its own audit log, or clear an approval queue, and there
 * is no in-app path back, because every route to the power requires already
 * holding it.
 *
 * `ensureSuperAdmin` at boot does not cover this: it promotes only when there
 * are *no* super admins at all. A workspace whose single super admin is the
 * wrong person has one, so nothing fires.
 *
 * Grants nothing that server access did not already carry, and leaves the same
 * record the in-app button would: an audit entry, and every other admin told.
 */
async function promoteFor(email, { reason = null } = {}) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) throw new RecoveryError('An email address is required.');

  const matches = await db.filter('users', (u) => String(u.email).toLowerCase() === wanted);
  const user = matches[0];
  if (!user) throw new RecoveryError(`No account found for ${email}.`);
  if (user.role !== 'admin') {
    throw new RecoveryError(
      `${user.name} is a ${user.role}, not an administrator. Make them an admin first; `
      + 'super admin is a standing an administrator holds, not a role of its own.',
    );
  }
  if (roles.isSuperAdmin(user)) {
    return { user, alreadySuper: true };
  }

  // Trusted comes with it. There is nobody above a super admin to countersign,
  // so holding their changes for approval would deadlock the workspace -- the
  // same reason the standing route pairs the two.
  await db.update('users', user.id, {
    isSuperAdmin: true,
    adminTrusted: true,
    adminTrustedAt: new Date().toISOString(),
    adminTrustedBy: 'system',
  });
  await audit(null, 'standing', 'user', user.id, {
    isSuperAdmin: true,
    adminTrusted: true,
    via: 'admin_recovery_script',
    reason: reason || null,
  });
  await admins.notifyAdmins(
    `${user.name} was made a super admin from the server console`
      + `${reason ? ` (${reason})` : ''}. If this was not expected, treat it as a security event.`,
    'security',
    { exceptUserId: user.id },
  );

  return { user, alreadySuper: false };
}

// --- the command line ------------------------------------------------------

function usage() {
  return [
    'Break-glass administrator access for a workspace that cannot help itself.',
    '',
    'Usage:',
    '  npm run admin:recovery -- list',
    '  npm run admin:recovery -- issue <email> [--reason "..."] --yes',
    '  npm run admin:recovery -- promote <email> [--reason "..."] --yes',
    '',
    'Options:',
    '  --yes             Actually do it. Without this, both commands only show what would happen.',
    '  --reason "..."    Recorded in the audit log and in the alert to the other admins.',
    '',
    'issue     replaces one administrator\'s backup sign-in codes and prints them once.',
    '          They cannot be recovered afterwards -- hand them over, then clear your',
    '          terminal scrollback.',
    '',
    'promote   makes an administrator a super admin, for when the only one left is',
    '          unreachable and there is no in-app way to appoint another.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { command: argv[0] || 'help', email: null, reason: null, confirmed: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') args.confirmed = true;
    else if (arg === '--reason') args.reason = argv[++i] || null;
    else if (!arg.startsWith('-') && !args.email) args.email = arg;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(usage());
    return 0;
  }

  // A fresh deployment may not have the table yet. Creating it is safe and
  // idempotent; seeding accounts is not this tool's job.
  await initSchema();

  if (args.command === 'list') {
    const rows = await listAdmins();
    if (rows.length === 0) {
      console.log('No administrator accounts exist yet. Start the server once so the workspace is seeded.');
      return 1;
    }
    console.log(`${rows.length} administrator${rows.length === 1 ? '' : 's'}:\n`);
    for (const r of rows) {
      const badges = [r.isSuperAdmin ? 'super admin' : r.trusted ? 'trusted' : 'untrusted'].join(', ');
      console.log(`  ${r.email}`);
      console.log(`    ${r.name} · ${badges} · ${r.remaining} of ${r.total} backup codes left`);
    }
    console.log('\nTo issue a fresh set:  npm run admin:recovery -- issue <email> --yes');
    return 0;
  }

  if (args.command !== 'issue' && args.command !== 'promote') {
    console.error(`Unknown command: ${args.command}\n`);
    console.error(usage());
    return 1;
  }

  if (!args.email) {
    console.error('Which administrator? Pass an email address.\n');
    console.error(usage());
    return 1;
  }

  if (args.command === 'promote') {
    const wanted = String(args.email).trim().toLowerCase();
    const user = (await db.filter('users', (u) => String(u.email).toLowerCase() === wanted))[0];
    if (!user) {
      console.error(`No account found for ${args.email}.`);
      return 1;
    }

    if (!args.confirmed) {
      const supers = await roles.listSuperAdmins();

      // Nothing to offer someone who already holds it. Printing a plan here
      // invites --yes on a command that would do nothing, and reads as though
      // the standing were somehow incomplete.
      if (roles.isSuperAdmin(user)) {
        console.log(`${user.name} <${user.email}> is already a super admin. Nothing to do.`);
        console.log(`\nThis workspace has ${supers.length} super admin${supers.length === 1 ? '' : 's'}:`);
        for (const s of supers) console.log(`  ${s.email}`);
        return 0;
      }

      console.log('Nothing has been changed. This is what would happen:\n');
      console.log(`  Account   ${user.name} <${user.email}> (${user.role})`);
      console.log(`  Now       ${roles.isTrustedAdmin(user) ? 'trusted admin' : 'untrusted admin'}`);
      console.log('  Would     become a super admin, and trusted along with it');
      console.log(`  Super admins afterwards  ${supers.length + 1}`);
      console.log('  Recorded  audit log entry, and a security alert to every other admin');
      console.log('\nRe-run with --yes to go ahead.');
      return 0;
    }

    const { user: promoted, alreadySuper } = await promoteFor(args.email, { reason: args.reason });
    if (alreadySuper) {
      console.log(`${promoted.name} <${promoted.email}> is already a super admin. Nothing to do.`);
      return 0;
    }
    console.log(`\n${promoted.name} <${promoted.email}> is now a super admin.`);
    console.log('They can appoint admins, read the audit log, and act without a second signature.');
    console.log('They must sign out and back in for their new powers to appear in the browser.');
    console.log('');
    console.log('This has been written to the audit log and announced to the other administrators.');
    return 0;
  }

  if (!args.confirmed) {
    const wanted = String(args.email).trim().toLowerCase();
    const matches = await db.filter('users', (u) => String(u.email).toLowerCase() === wanted);
    const user = matches[0];
    if (!user) {
      console.error(`No account found for ${args.email}.`);
      return 1;
    }
    const status = await recoveryCodes.statusFor(user.id);
    console.log('Nothing has been changed. This is what would happen:\n');
    console.log(`  Account   ${user.name} <${user.email}> (${user.role})`);
    console.log(`  Now       ${status.remaining} of ${status.total} backup codes left`);
    console.log(`  Would     replace them with ${recoveryCodes.CODE_COUNT} new ones, printed once`);
    console.log('  Recorded  audit log entry, and an in-app alert to every other admin');
    console.log('\nRe-run with --yes to go ahead.');
    return 0;
  }

  const { user, codes, replaced } = await issueFor(args.email, { reason: args.reason });

  console.log(`\nBackup sign-in codes for ${user.name} <${user.email}>`);
  if (replaced > 0) console.log(`(${replaced} earlier code${replaced === 1 ? '' : 's'} stopped working just now)`);
  console.log('');
  for (const code of codes) console.log(`  ${code}`);
  console.log('');
  console.log('Each works once, in place of the emailed sign-in code. The password step still applies.');
  console.log('They are not stored anywhere readable and cannot be shown again.');
  console.log('Hand them over, then clear your terminal scrollback.');
  console.log('');
  console.log('This has been written to the audit log and announced to the other administrators.');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof RecoveryError) {
        console.error(err.message);
        process.exit(1);
      }
      console.error('Could not issue backup codes:', err.message);
      process.exit(1);
    });
}

module.exports = { main, listAdmins, issueFor, promoteFor, parseArgs, usage, RecoveryError };
