'use strict';

/**
 * Does the SMS bridge actually work right now, and if not, which part?
 *
 * Every integration call in this bridge is best-effort by design: a Slack
 * outage must not take an inbound text down with it. The cost of that design is
 * that a *permanent* misconfiguration looks exactly like a transient outage --
 * one line in a log nobody is reading, and a bridge that appears to be running
 * while doing nothing at all. A missing scope, a bot that was never invited to
 * the channel, a status callback pointing at the wrong host: each of them is
 * silent, and each of them is a five-second fix once somebody knows.
 *
 * So this asks all of the questions once at boot, and again whenever an admin
 * opens the integrations page. It changes nothing and repairs nothing -- it
 * reports, in the words the person reading it would use.
 */

const slack = require('./slack');
const twilio = require('./twilio');
const tasks = require('./smsTasks');
const identity = require('./slackIdentity');
const completion = require('./smsCompletion');

/** One finding. `ok` false means the bridge is degraded in the way `detail` says. */
function result(name, ok, detail, fix = null) {
  return { name, ok, detail, fix };
}

/**
 * Can we receive a text at all?
 *
 * The inbound half has its own failure mode worth naming: TWILIO_WEBHOOK_URL
 * has to be the exact URL Twilio calls, because it is part of what Twilio
 * signed. A mismatch rejects every inbound message with a 403 that looks
 * identical to an attack.
 */
function checkTwilio() {
  const checks = [];

  checks.push(result(
    'Twilio credentials',
    twilio.isEnabled(),
    twilio.isEnabled() ? 'set' : 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set',
    'Set both, from the Twilio console.',
  ));

  const inbound = process.env.TWILIO_WEBHOOK_URL;
  checks.push(result(
    'Inbound webhook URL',
    Boolean(inbound),
    inbound ? inbound.trim() : 'not set, so the signature is checked against a guessed URL',
    'Set TWILIO_WEBHOOK_URL to the exact URL configured on the Twilio number.',
  ));

  const callback = twilio.statusCallbackUrl();
  checks.push(result(
    'Delivery status callback',
    Boolean(callback),
    callback
      ? callback
      : 'not configured, so a text the carrier later rejects is still recorded as sent',
    'Set TWILIO_STATUS_CALLBACK_URL to <your app>/api/sms/status.',
  ));

  checks.push(result(
    'Outbound sending',
    twilio.outboundEnabled(),
    twilio.outboundEnabled()
      ? 'on'
      : 'off -- @send records the attempt and tells the thread, but nothing leaves',
    'Set SMS_OUTBOUND_ENABLED=on once A2P 10DLC registration has cleared.',
  ));

  return checks;
}

/**
 * Can we post a card, edit it, and read the commands typed under it?
 *
 * The membership question is the one worth asking out loud. `chat.postMessage`
 * to a channel the bot is not in fails with `not_in_channel`, which the posting
 * path swallows -- so the symptom is texts arriving and no cards appearing,
 * with nothing anywhere saying why.
 */
async function checkSlack() {
  const checks = [];

  if (!slack.isEnabled()) {
    checks.push(result(
      'Slack connection',
      false,
      'SLACK_BOT_TOKEN is not set, so no cards are posted at all',
      'Add a bot token from the Slack app.',
    ));
    return checks;
  }

  checks.push(result('Slack connection', true, 'bot token set'));

  checks.push(result(
    'Slack events',
    slack.isEventsEnabled(),
    slack.isEventsEnabled()
      ? 'signing secret set'
      : 'SLACK_SIGNING_SECRET is not set, so no command typed in Slack can be verified or run',
    'Add the signing secret and point Event Subscriptions at <your app>/api/slack/events.',
  ));

  const configured = tasks.configuredChannel();
  if (!configured) {
    checks.push(result(
      'Task channel',
      false,
      'neither SMS_SLACK_CHANNEL nor SLACK_NOTIFICATION_CHANNEL is set',
      'Set SMS_SLACK_CHANNEL to the channel id cards should be posted into.',
    ));
    return checks;
  }

  let channelId = null;
  try {
    channelId = await tasks.channelId();
  } catch {
    channelId = null;
  }

  if (!channelId) {
    checks.push(result(
      'Task channel',
      false,
      `"${configured}" does not resolve to a channel the bot can see`,
      'Use the channel id, and invite the bot with /invite.',
    ));
    return checks;
  }

  let channel = null;
  try {
    channel = (await slack.fetchChannels()).find((c) => c.id === channelId) || null;
  } catch (err) {
    checks.push(result(
      'Task channel',
      false,
      `could not read the channel list: ${err.message}`,
      'Check the bot token and the channels:read scope.',
    ));
    return checks;
  }

  if (!channel) {
    checks.push(result(
      'Task channel',
      false,
      `${channelId} is not visible to the bot`,
      'Invite the bot to it: /invite @yourbot',
    ));
  } else if (!channel.isMember) {
    checks.push(result(
      'Task channel',
      false,
      `the bot can see #${channel.name} but is not a member, so posting a card fails`,
      `Run /invite @yourbot in #${channel.name}.`,
    ));
  } else {
    checks.push(result('Task channel', true, `#${channel.name} (${channelId}), bot is a member`));
  }

  return checks;
}

/**
 * Is there an answer to "who may work a task"?
 *
 * With neither an allowlist nor the email scope every command is refused, which
 * is the correct behaviour and a terrible surprise. Worth saying at boot rather
 * than discovering the first time somebody types `@accept`.
 */
async function checkAuthority() {
  const listed = identity.allowlist();
  if (listed.length > 0) {
    return [result('Who may work a task', true, `${listed.length} Slack member id(s) in SMS_TASK_OPERATORS`)];
  }

  if (!slack.isEnabled()) {
    return [result(
      'Who may work a task',
      false,
      'no allowlist, and no Slack token to look anybody up with',
      'Set SMS_TASK_OPERATORS, or connect Slack.',
    )];
  }

  let directory = {};
  try {
    directory = await slack.fetchUserMap();
  } catch (err) {
    return [result(
      'Who may work a task',
      false,
      `no allowlist, and the Slack directory could not be read: ${err.message}`,
      'Set SMS_TASK_OPERATORS, or fix the users:read scope.',
    )];
  }

  const withEmail = Object.values(directory).filter((u) => u.email && !u.isBot).length;
  if (withEmail === 0) {
    return [result(
      'Who may work a task',
      false,
      'no allowlist, and no Slack account has an email -- so every command will be refused',
      'Add the users:read.email scope and reinstall the app, or set SMS_TASK_OPERATORS.',
    )];
  }

  return [result('Who may work a task', true, `matching ${withEmail} Slack account(s) by email`)];
}

/** Can Claude write the completion text, or will every bare `@send` decline? */
function checkDrafting() {
  return [result(
    'Drafting the completion',
    completion.isEnabled(),
    completion.isEnabled()
      ? `${completion.model()}`
      : 'ANTHROPIC_API_KEY is not set, so `@send` on its own declines and only `@send <text>` works',
    'Set ANTHROPIC_API_KEY.',
  )];
}

/**
 * The whole picture. Never throws -- a preflight that falls over is worse than
 * no preflight, because it takes the thing it was inspecting down with it.
 */
async function check() {
  const checks = [];
  try {
    checks.push(...checkTwilio());
    checks.push(...(await checkSlack()));
    checks.push(...(await checkAuthority()));
    checks.push(...checkDrafting());
  } catch (err) {
    checks.push(result('Preflight', false, `could not finish: ${err.message}`));
  }

  const problems = checks.filter((c) => !c.ok);
  return { ok: problems.length === 0, checks, problems };
}

/**
 * Run the checks at boot and say what is wrong, once, where somebody will see it.
 *
 * Deliberately loud and deliberately non-fatal: the rest of the app has no
 * business failing to start because Slack is misconfigured, but nobody should
 * have to go looking to find out that it is.
 */
async function reportAtBoot() {
  const report = await check();

  if (report.ok) {
    console.log('[sms-bridge] ready: texts in, cards in Slack, one reply out.');
    return report;
  }

  console.warn(`[sms-bridge] running with ${report.problems.length} problem(s):`);
  for (const problem of report.problems) {
    console.warn(`[sms-bridge]   ${problem.name}: ${problem.detail}`);
    if (problem.fix) console.warn(`[sms-bridge]     -> ${problem.fix}`);
  }
  return report;
}

module.exports = { check, reportAtBoot };
