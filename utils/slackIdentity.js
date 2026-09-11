'use strict';

/**
 * Who a Slack user is in dashboard terms, and whether they may work a task.
 *
 * The SMS bridge used to answer this by not asking: any human message in a
 * task thread that started with a command ran it, so anybody who could see the
 * channel could close a task and text a client. Slack channels are shared with
 * contractors, clients and guests all the time, and `@send` is the one action
 * in this app that reaches a phone belonging to somebody outside the company.
 *
 * Two ways to answer, in order:
 *
 *   1. SMS_TASK_OPERATORS -- an explicit list of Slack user ids. No lookup, no
 *      extra scope, no dependency on the two directories agreeing. Set this and
 *      it is the whole answer.
 *
 *   2. Slack email -> dashboard account -> role. Nothing to maintain by hand,
 *      and it reuses the role model the rest of the app already runs on, but it
 *      needs the `users:read.email` scope and an account whose Slack email
 *      matches its dashboard email.
 *
 * When neither can answer, the command is refused. Failing closed is the entire
 * point: a bridge that cannot tell who is talking must not be the thing that
 * decides to text a customer. The refusal names both fixes, because the person
 * who hits it is usually the person who can apply one.
 */

const { db } = require('../db/setup');
const slack = require('./slack');

/** Roles that may work a task: claim it, give it an owner, close it out. */
const OPERATOR_ROLES = ['admin', 'project_manager'];

/**
 * The explicit allowlist, if there is one.
 *
 * Slack user ids, comma or space separated -- the id, not the display name,
 * because display names change and are not unique. Find one in Slack under
 * the person's profile -> the three dots -> "Copy member ID".
 */
function allowlist() {
  const raw = process.env.SMS_TASK_OPERATORS || '';
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * The dashboard account behind a Slack user id, or null.
 *
 * Matched on email, lowercased on both sides. A Slack account with no email
 * visible to us -- the scope is missing, or it is a bot -- matches nothing,
 * which the caller must read as "unknown", never as "not allowed but fine".
 */
async function dashboardUser(slackUserId) {
  if (!slackUserId) return null;

  let directory;
  try {
    directory = await slack.fetchUserMap();
  } catch (err) {
    console.error('Could not read the Slack directory:', err.message);
    return null;
  }

  const profile = directory?.[slackUserId];
  if (!profile || profile.isBot || profile.deleted || !profile.email) return null;

  const accounts = await db.filter('users', (u) => Boolean(u.email));
  return accounts.find((u) => String(u.email).toLowerCase() === profile.email) || null;
}

/**
 * Whether this Slack user may run task commands.
 *
 * Returns `{ allowed }` or `{ allowed: false, reason }`, where the reason is
 * written to be posted straight into the thread -- the person who typed the
 * command is the one who needs to read it.
 */
async function canOperate(slackUserId) {
  if (!slackUserId) {
    return { allowed: false, reason: 'I could not tell who sent that, so nothing was done.' };
  }

  const allowed = allowlist();
  if (allowed.length > 0) {
    if (allowed.includes(String(slackUserId).toUpperCase())) return { allowed: true };
    return {
      allowed: false,
      reason: 'Only the people listed in `SMS_TASK_OPERATORS` can work a task, and you are not one of them. Ask an admin to add your Slack member id.',
    };
  }

  const account = await dashboardUser(slackUserId);

  if (!account) {
    return {
      allowed: false,
      reason:
        'I cannot match your Slack account to a dashboard account, so I will not text a customer on your behalf. ' +
        'An admin can fix this by giving the Slack app the `users:read.email` scope (your Slack email then has to match ' +
        'your dashboard email), or by listing the Slack member ids that may work tasks in `SMS_TASK_OPERATORS`.',
    };
  }

  if (!OPERATOR_ROLES.includes(account.role)) {
    return {
      allowed: false,
      reason: `Working a task is for admins and project managers. Your dashboard account (${account.email}) is a ${account.role}.`,
    };
  }

  return { allowed: true, account };
}

module.exports = { canOperate, dashboardUser, allowlist, OPERATOR_ROLES };
