'use strict';

/**
 * When we are allowed to ask somebody to upgrade, and what we say.
 *
 * The rules are a ceiling, not a schedule. Research on subscription upgrades
 * is consistent that a prompt tied to a real moment -- hitting a limit,
 * opening a locked feature -- converts, and that a repeated generic prompt is
 * a recognised dark pattern that costs more trust than it earns revenue. So
 * nothing here fires on a timer; it fires when the ceiling allows and nothing
 * better has already happened.
 *
 *   never      Unlimited, anybody without an active plan, anybody whose
 *              payment is pending or past due, and the first 7 days after a
 *              purchase or an upgrade.
 *   at most    one modal per client per 7 days, counting the prompts the
 *              ticket form has already shown them.
 *   after 3    consecutive "Not now" answers, the ceiling drops to 30 days.
 *   snooze     "Remind me in 30 days" is honoured exactly.
 *
 * The streak resets the moment somebody clicks through or upgrades, because at
 * that point they were interested and the three refusals before it were about
 * timing rather than about the offer.
 *
 * Deliberately **not** counted here: the locked panels on the Websites page.
 * Those are a permanent, passive part of a screen the client chose to open,
 * not an interruption, and spending the weekly budget on them would mean a
 * client who browses their own dashboard never hears from us at all.
 */

const { db } = require('../db/setup');
const plans = require('../lib/plans');
const subscriptions = require('./subscriptions');
const events = require('./membershipEvents');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nothing at all in the first week of a plan. They have just decided. */
const SETTLING_IN_DAYS = 7;

/** The ordinary ceiling, and the one a run of refusals earns. */
const NORMAL_GAP_DAYS = 7;
const BACKED_OFF_GAP_DAYS = 30;

/** Three "Not now" answers in a row is somebody telling us something. */
const BACKOFF_AFTER_DISMISSALS = 3;

/** "Remind me in 30 days" means 30 days. */
const SNOOZE_DAYS = 30;

/**
 * The rotating value messages.
 *
 * Basic is sold Managed, not Unlimited: the playbook recommends one plan with
 * a reason, and the step from doing everything yourself to someone doing two
 * changes a month is the one that actually describes their life. Managed is
 * sold Unlimited.
 *
 * Every line is a true statement about what the plans include. The price
 * differences are computed from lib/plans.js at render time rather than
 * written in, so "$10 more a month" cannot drift away from the price list.
 */
const MESSAGES = {
  basic: [
    {
      key: 'basic-changes',
      body: 'Tired of handling site changes yourself? On Managed, we make {{included}} changes a '
        + "month for you, keep everything updated, and check your site's health every month. "
        + "That's {{difference}} more a month.",
    },
    {
      key: 'basic-tickets',
      body: 'Right now you handle your own updates. Managed means we do them for you, and you just '
        + 'raise a ticket.',
    },
    {
      key: 'basic-no-lifting',
      body: 'When something on your site needs fixing, Managed gets it to our team without you '
        + 'lifting a finger. {{included}} changes a month included.',
    },
  ],
  managed: [
    {
      key: 'managed-no-limit',
      body: 'You get {{included}} changes a month. Unlimited removes the limit, adds priority '
        + 'support with a guaranteed response time, and daily backups. For {{difference}} more, '
        + "that's {{perDay}}.",
    },
    {
      key: 'managed-seo',
      body: 'Your site is updated and checked monthly. Unlimited adds ongoing SEO work, so your '
        + 'site keeps bringing in calls, plus a monthly report showing what we did.',
    },
    {
      key: 'managed-uptime',
      body: 'If your site went down tonight, would you know? Unlimited includes 24/7 uptime '
        + 'monitoring and daily backups with quick restore.',
    },
    {
      key: 'managed-busy-season',
      body: 'Busy season coming? Unlimited means no counting requests. Send us every change you '
        + 'need and it gets priority.',
    },
  ],
};

function daysAgo(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

/** How long must pass before we may ask again. */
function gapDaysFor(client) {
  const streak = Number(client.upsellDismissStreak || 0);
  return streak >= BACKOFF_AFTER_DISMISSALS ? BACKED_OFF_GAP_DAYS : NORMAL_GAP_DAYS;
}

/**
 * Whether we may show this client an upgrade prompt right now, and why not.
 *
 * The reason is returned rather than a bare false because it is the only way
 * to tell "this client is happy on Unlimited" from "we asked them on Tuesday",
 * and the staff view of the funnel is useless without that distinction.
 */
async function eligibility(client, now = new Date()) {
  if (!client || client.role !== 'client') return { ok: false, reason: 'not_a_client' };

  const state = await subscriptions.stateFor(client, now);

  // Unlimited has nothing to be sold. Asking anyway is how a product starts
  // feeling like it is working against the person paying for it.
  if (!state.planKey) return { ok: false, reason: 'no_active_plan', state };
  if (!plans.recommendedUpgradeFor(state.planKey)) return { ok: false, reason: 'top_plan', state };

  // Somebody mid-payment or behind on one is not somebody to upsell.
  if (state.awaitingPayment) return { ok: false, reason: 'awaiting_payment', state };
  if (state.pastDue) return { ok: false, reason: 'past_due', state };
  if (state.endingAt) return { ok: false, reason: 'cancelling', state };

  const started = state.subscription?.startedAt ? new Date(state.subscription.startedAt) : null;
  if (started && now.getTime() - started.getTime() < SETTLING_IN_DAYS * DAY_MS) {
    return { ok: false, reason: 'settling_in', state };
  }

  const snoozed = client.upsellSnoozedUntil ? new Date(client.upsellSnoozedUntil) : null;
  if (snoozed && !Number.isNaN(snoozed.getTime()) && snoozed > now) {
    return { ok: false, reason: 'snoozed', state, until: client.upsellSnoozedUntil };
  }

  // The ceiling, counting the prompts the ticket form has already shown them.
  // A client who hit their limit on Monday and was offered Unlimited there
  // does not also get a modal about it on Wednesday.
  const gap = gapDaysFor(client);
  const since = daysAgo(gap);
  const shown = await events.countSince(client.id, ['upsell_shown'], since);
  if (shown > 0) return { ok: false, reason: 'asked_recently', state, gapDays: gap };

  return { ok: true, state };
}

/**
 * How many recent whole months this client used their entire allowance.
 *
 * Used for the one personalised line, and only when it is true of them. A
 * figure somebody can check and find wrong costs more than the generic
 * sentence it replaced.
 */
async function monthsAtLimit(clientId, included, now = new Date()) {
  if (!included) return 0;
  const rows = await db.filter('update_request_usage', (u) => u.clientId === clientId);
  if (rows.length === 0) return 0;

  const current = rows
    .slice()
    .sort((a, b) => String(b.periodStart || '').localeCompare(String(a.periodStart || '')));

  let streak = 0;
  for (const row of current) {
    // Skip the month still running: it is not evidence of anything yet.
    if (row.periodEnd && new Date(row.periodEnd) > now) continue;
    if (Number(row.count || 0) >= included) streak += 1;
    else break;
  }
  return streak;
}

/**
 * The line to show, never the same one twice in a row.
 *
 * Falls back to the first in the list when every message has been used, which
 * only happens if somebody has been offered an upgrade more times than the
 * rotation is long -- the frequency rules make that a matter of months.
 */
function pickMessage(planKey, lastKey) {
  const list = MESSAGES[planKey] || [];
  if (list.length === 0) return null;
  const options = list.filter((m) => m.key !== lastKey);
  const pool = options.length > 0 ? options : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] ?? ''));
}

/**
 * The prompt to show this client, or null.
 *
 * Builds the whole thing -- the message, the comparison, and what the upgrade
 * would cost -- so the browser renders what it is given rather than deciding
 * anything. Every figure comes from lib/plans.js and the live quote, which is
 * the same quote the client is charged from if they accept.
 */
async function promptFor(client, now = new Date()) {
  const check = await eligibility(client, now);
  if (!check.ok) return null;

  const state = check.state;
  const fromKey = state.planKey;
  const toKey = plans.recommendedUpgradeFor(fromKey);
  const from = plans.describePlan(fromKey);
  const to = plans.describePlan(toKey);

  const difference = plans.money(to.monthlyUsd - from.monthlyUsd);
  const perDay = difference / 30;

  // Personalised when it is true of them, generic otherwise.
  const atLimit = await monthsAtLimit(client.id, from.updateRequestsPerMonth, now);
  const personalised = atLimit >= 2
    ? {
      key: 'personalised-at-limit',
      body: `You used ${from.updateRequestsPerMonth} of ${from.updateRequestsPerMonth} updates in `
        + `each of the last ${atLimit} months. Unlimited removes the limit.`,
    }
    : null;

  const message = personalised || pickMessage(fromKey, client.upsellLastMessage);
  if (!message) return null;

  // What they would actually pay today, credit included. The same function the
  // checkout uses, so the figure in the prompt is the figure on the invoice.
  const period = state.subscription?.period || 1;
  const quote = await subscriptions.quoteFor(client.id, toKey, period, now);

  return {
    messageKey: message.key,
    message: fill(message.body, {
      included: String(from.updateRequestsPerMonth ?? ''),
      difference: plans.formatUsd(difference),
      perDay: perDay < 1 ? 'under $1 a day' : `about ${plans.formatUsd(Math.round(perDay))} a day`,
    }),
    from: {
      key: from.key,
      name: from.name,
      monthlyUsd: from.monthlyUsd,
      entitlements: from.entitlements,
    },
    to: {
      key: to.key,
      name: to.name,
      monthlyUsd: to.monthlyUsd,
      entitlements: to.entitlements,
    },
    // Only what changes. A comparison that repeats what they already have
    // makes the step up look smaller than it is.
    gained: plans.gainedEntitlements(fromKey, toKey),
    differenceUsd: difference,
    quote,
  };
}

/**
 * Record that a prompt was put in front of somebody.
 *
 * Two writes, and both matter: the event is the funnel, and the stamp on the
 * account is what the frequency check reads without scanning the event table
 * on every dashboard load.
 */
async function markShown(client, { messageKey = null, trigger = 'weekly' } = {}) {
  await events.log('upsell_shown', {
    clientId: client.id,
    metadata: { messageKey, trigger },
  });
  await db.update('users', client.id, {
    upsellLastShownAt: new Date().toISOString(),
    ...(messageKey ? { upsellLastMessage: messageKey } : {}),
  });
}

/** "Not now". Counts against them, and three in a row drops the ceiling. */
async function markDismissed(client, { messageKey = null } = {}) {
  const streak = Number(client.upsellDismissStreak || 0) + 1;
  await events.log('upsell_dismissed', {
    clientId: client.id,
    metadata: { messageKey, streak },
  });
  await db.update('users', client.id, { upsellDismissStreak: streak });
  return streak;
}

/** "Remind me in 30 days". Honoured exactly, and not counted as a refusal. */
async function markSnoozed(client, { messageKey = null } = {}) {
  const until = new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString();
  await events.log('upsell_snoozed', {
    clientId: client.id,
    metadata: { messageKey, until },
  });
  await db.update('users', client.id, { upsellSnoozedUntil: until });
  return until;
}

/**
 * They clicked through. The streak resets: three refusals before this were
 * about timing, not about the offer.
 */
async function markClicked(client, { messageKey = null } = {}) {
  await events.log('upsell_clicked', {
    clientId: client.id,
    metadata: { messageKey },
  });
  await db.update('users', client.id, {
    upsellDismissStreak: 0,
    upsellSnoozedUntil: null,
  });
}

module.exports = {
  MESSAGES,
  SETTLING_IN_DAYS,
  NORMAL_GAP_DAYS,
  BACKED_OFF_GAP_DAYS,
  BACKOFF_AFTER_DISMISSALS,
  SNOOZE_DAYS,
  eligibility,
  gapDaysFor,
  monthsAtLimit,
  pickMessage,
  promptFor,
  markShown,
  markDismissed,
  markSnoozed,
  markClicked,
};
