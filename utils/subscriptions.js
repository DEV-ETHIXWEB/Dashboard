'use strict';

/**
 * What plan a client is on, what that unlocks, and how much of this month's
 * allowance they have used.
 *
 * The one rule everything here follows: **perks never unlock before payment is
 * confirmed.** A `pending_payment` subscription is a client who has chosen a
 * plan and not paid for it, and it grants nothing. Only `active` does.
 *
 * Reads live here. Writes -- choosing a plan, marking it paid, upgrading,
 * cancelling -- come in the steps after this one, and will be the only things
 * allowed to set a status, so the "one active plan per client" promise has a
 * single enforcement point rather than six callers each remembering it.
 */

const { db } = require('../db/setup');
const plans = require('../lib/plans');
const events = require('./membershipEvents');

/**
 * The statuses a subscription can be in. `active` is the only one that grants.
 *
 * `scheduled` is a plan the client has chosen that does not begin today: a
 * downgrade. It is deliberately not `pending_payment`, because there is
 * nothing to pay yet -- the client was told "nothing to pay now" and the
 * period they already paid for has to run to its end. A scheduled row grants
 * nothing, is not on the admin's list of payments to collect, and cannot be
 * marked paid; `promoteScheduled` moves it to `pending_payment` on the day it
 * is due to start.
 */
const STATUSES = ['pending_payment', 'scheduled', 'active', 'past_due', 'cancelled', 'expired'];

/**
 * What a client with no subscription row at all can see.
 *
 * Every client in the workspace today is in exactly this position, and the
 * honest reading of "no plan yet" on the morning this ships is *not* "no
 * perks". Taking a working dashboard away from paying clients to sell them
 * something is the wrong order of operations, and it is also how a support
 * queue fills up in an afternoon.
 *
 * So an account with no subscription keeps everything and is *asked*, through
 * the banner and the plans modal, not cut off. Set
 * MEMBERSHIP_ENFORCE_WITHOUT_PLAN=on once everybody has been migrated onto a
 * plan and the grandfather clause stops applying to anybody real.
 *
 * Deliberately one function rather than a flag read in several places: when
 * this changes it has to change everywhere at once.
 */
function enforcedWithoutPlan() {
  return String(process.env.MEMBERSHIP_ENFORCE_WITHOUT_PLAN || '').trim().toLowerCase() === 'on';
}

/**
 * Every subscription this client has ever had, newest first.
 *
 * Asked for by client rather than read out of the whole table: `stateFor`
 * hangs off this and runs on nearly every page a client opens, so it is one of
 * the hottest reads in the application.
 */
async function historyFor(clientId) {
  if (!clientId) return [];
  const rows = await db.where('subscriptions', { clientId });
  return rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * The subscription that currently governs this client, or null.
 *
 * `active` wins outright. Failing that, a payment we are waiting on is what
 * the billing page should be talking about, then one that has gone past due.
 * A cancelled or expired row is history and governs nothing -- which is also
 * why the order below is explicit rather than "the newest row": the newest row
 * after a cancellation is the cancellation.
 */
async function currentFor(clientId) {
  const history = await historyFor(clientId);
  const byStatus = (status) => history.find((s) => s.status === status) || null;
  return byStatus('active') || byStatus('pending_payment') || byStatus('past_due') || null;
}

/** The one a client is actually paying for, or null. Nothing else grants perks. */
async function activeFor(clientId) {
  const history = await historyFor(clientId);
  return history.find((s) => s.status === 'active') || null;
}

/**
 * Whether this client has ever actually paid us for a plan.
 *
 * The grandfather clause turns on this rather than on "has no subscription
 * row", and the difference matters a great deal. A client who presses "Choose
 * Unlimited" has a row the moment they press it, and that row is
 * `pending_payment` until an admin confirms the money. If the clause keyed on
 * the row existing, choosing a plan would take their whole dashboard away
 * until we got round to marking it paid -- punishing them for saying yes, in
 * the window where they are most likely to change their mind.
 *
 * `markedPaidAt` is the signal because it is written once, by the only code
 * allowed to confirm a payment, and never cleared. A cancellation years later
 * does not make somebody un-paid.
 */
async function hasEverPaid(clientId) {
  const history = await historyFor(clientId);
  return history.some((s) => Boolean(s.markedPaidAt));
}

/**
 * The subscription whose entitlements apply right now, or null.
 *
 * Three states grant, and each for a reason:
 *
 *   active      the ordinary case: they are paying, they get the perks.
 *   past_due    a card failed and the retry is in flight. Cutting a client's
 *               dashboard off the hour their bank declined a payment is both
 *               unkind and bad business -- most of these are fixed within a
 *               day. The billing page says so loudly instead.
 *   cancelled   until `renews_at`. They paid for the period and the playbook
 *               promises hosting continues to the end of it, so the perks do
 *               too. Past that date it grants nothing.
 *
 * `pending_payment` is absent on purpose, and is the line the whole feature
 * rests on: perks never unlock before payment is confirmed.
 */
function governs(subscription, now = new Date()) {
  if (!subscription) return false;
  if (subscription.status === 'active') return true;
  if (subscription.status === 'past_due') return true;
  if (subscription.status === 'cancelled') {
    if (!subscription.renewsAt) return false;
    const until = new Date(subscription.renewsAt);
    if (Number.isNaN(until.getTime())) return false;
    return until > (now instanceof Date ? now : new Date(now));
  }
  return false;
}

/**
 * The governing subscription for a client, preferring the one they are paying
 * for over one that is merely running out.
 */
async function governingFor(clientId, now = new Date()) {
  const history = await historyFor(clientId);
  return history.find((s) => s.status === 'active')
    || history.find((s) => s.status === 'past_due' && governs(s, now))
    || history.find((s) => s.status === 'cancelled' && governs(s, now))
    || null;
}

/**
 * The monthly window the update allowance is counted in.
 *
 * Anchored to the day the subscription started, not the first of the month: a
 * client who paid on the 20th gets their two updates back on the 20th, which
 * is what "every month" means to the person paying. A six or twelve month plan
 * is paid upfront but the allowance still resets monthly, so this walks
 * forward from the start date in whole months regardless of the period bought.
 *
 * Returns null when there is nothing to count against.
 */
function usageWindow(subscription, now = new Date()) {
  if (!subscription || !subscription.startedAt) return null;

  const start = new Date(subscription.startedAt);
  if (Number.isNaN(start.getTime())) return null;

  const at = now instanceof Date ? now : new Date(now);

  // How many whole months have elapsed since the anchor. Counted in months
  // rather than by dividing elapsed milliseconds, because months are not all
  // the same length and a 30-day assumption drifts a client's reset day by
  // five days a year.
  let months = (at.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (at.getUTCMonth() - start.getUTCMonth());
  if (at.getUTCDate() < start.getUTCDate()) months -= 1;
  if (months < 0) months = 0;

  const periodStart = plans.renewalDate(start, months);
  const periodEnd = plans.renewalDate(start, months + 1);

  return { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() };
}

/**
 * The id of a usage counter.
 *
 * Derived from the client and the window rather than random, which is what
 * makes the counter race-safe: two requests submitted in the same second both
 * try to create this id, the database refuses the second, and the loser reads
 * the winner's row instead of opening a second counter. See the primary key in
 * db/setup.js and the test in scripts/test-membership.js.
 */
function usageId(clientId, periodStart) {
  return `usage-${clientId}-${String(periodStart).slice(0, 10)}`;
}

/**
 * This client's allowance for the current window: what they get, what they
 * have used, what is left, and when it comes back.
 *
 * Never creates the counter row. A client who has raised no requests this
 * month has no row, and reading their billing page is not the moment to write
 * one -- the row is created by the request that first consumes the allowance.
 */
async function usageFor(clientId, subscription, now = new Date()) {
  const plan = subscription ? plans.planFor(subscription.planKey) : null;
  const included = plan ? plan.updateRequestsPerMonth : null;
  const window = usageWindow(subscription, now);

  // Unlimited, or no plan to count against: there is no meter to show.
  if (!window || included === null) {
    return {
      unlimited: included === null && Boolean(plan),
      included,
      used: 0,
      extraUsed: 0,
      remaining: null,
      periodStart: window ? window.periodStart : null,
      resetsAt: window ? window.periodEnd : null,
    };
  }

  const row = await db.find('update_request_usage', usageId(clientId, window.periodStart));
  const used = Number(row?.count || 0);
  const extraUsed = Number(row?.extraCount || 0);

  return {
    unlimited: false,
    included,
    used,
    extraUsed,
    remaining: Math.max(0, included - used),
    periodStart: window.periodStart,
    resetsAt: window.periodEnd,
  };
}

/**
 * Everything a screen or a server-side guard needs to know about one client's
 * membership, in one object.
 *
 * `planKey` is the plan whose entitlements apply *right now*, which is not
 * always the plan on the subscription row: a client with no subscription is
 * grandfathered onto the full set until we say otherwise, and a client who has
 * chosen a plan but not paid for it gets nothing extra yet.
 */
async function stateFor(client, now = new Date()) {
  const clientId = client?.id || null;
  if (!clientId) {
    return emptyState();
  }

  const history = await historyFor(clientId);
  const byStatus = (status) => history.find((s) => s.status === status) || null;

  // What the billing page talks about: active first, then a payment we are
  // waiting on, then one that has gone past due. A cancelled row is history,
  // unless it is the only thing there is to report.
  const subscription = byStatus('active')
    || byStatus('pending_payment')
    || byStatus('past_due')
    || byStatus('cancelled')
    || null;

  const active = byStatus('active');
  // A plan they have chosen and not paid for. It sits *alongside* an active
  // one during an upgrade, because the plan they are already paying for has to
  // keep running until the new money lands -- a client must never be between
  // two plans and covered by neither.
  const pending = byStatus('pending_payment');
  // A downgrade they have chosen that starts when the current period ends.
  // Reported separately from both of the above: it is not awaiting payment and
  // it is not what they are on, and a billing page that showed it as either
  // would be telling the client something untrue.
  const scheduled = byStatus('scheduled');
  const governing = history.find((s) => s.status === 'active')
    || history.find((s) => s.status === 'past_due' && governs(s, now))
    || history.find((s) => s.status === 'cancelled' && governs(s, now))
    || null;

  // The plan whose perks are unlocked, which is governed rather than merely
  // chosen. A `pending_payment` row is absent from `governing` on purpose.
  const paidPlanKey = governing ? governing.planKey : null;

  // Never paid us for a plan, so the grandfather clause still applies. Note
  // this is deliberately not "has no subscription row": a client who has just
  // chosen a plan and not yet paid keeps everything they had this morning.
  const everPaid = history.some((s) => Boolean(s.markedPaidAt));
  const grandfathered = !everPaid && !paidPlanKey && !enforcedWithoutPlan();

  // Grandfathered accounts read the dashboard as though they were on
  // Unlimited. They are still shown the banner and the plans modal, because
  // the point is to ask them, not to quietly keep giving it away.
  const effectivePlanKey = paidPlanKey || (grandfathered ? 'unlimited' : null);

  // The allowance is counted against the plan that governs, so a client whose
  // card failed or whose cancellation has not run out yet still has the two
  // updates they paid for.
  const usage = await usageFor(clientId, governing, now);

  // The "you unlocked" moment, owed once per subscription. Computed here
  // rather than in the browser so the list of what is new comes from the same
  // config as everything else, and so a client cannot talk themselves into one
  // by editing a request.
  const unlock = active && !active.unlockSeenAt
    ? await describeUnlock(active, history)
    : null;

  return {
    clientId,
    subscription: subscription ? describe(subscription) : null,
    // Reported separately from `subscription` so a screen can say "you are on
    // Managed, and Unlimited is waiting on your payment" rather than having to
    // pick one of the two to talk about.
    pendingSubscription: pending ? describe(pending) : null,
    // The downgrade that begins when the paid period runs out, or null.
    scheduledSubscription: scheduled ? describe(scheduled) : null,
    // The plan they are actually on, or null. Never the pending one.
    planKey: paidPlanKey,
    plan: paidPlanKey ? plans.describePlan(paidPlanKey) : null,
    // What is unlocked. These two are the pair a guard reads.
    effectivePlanKey,
    entitlements: effectivePlanKey ? plans.entitlementsFor(effectivePlanKey).map((e) => e.key) : [],
    locked: effectivePlanKey ? plans.lockedEntitlementsFor(effectivePlanKey) : [],
    grandfathered,
    // True when we should be asking them to choose one: no plan they are
    // paying for. Drives the slim banner and the first-login modal, nothing
    // else -- it never gates access.
    needsPlan: !active,
    awaitingPayment: Boolean(byStatus('pending_payment')),
    pastDue: Boolean(active ? false : byStatus('past_due') && governs(byStatus('past_due'), now)),
    // A cancellation that has not run out yet. The billing page says when
    // hosting ends and offers the files handover.
    endingAt: governing && governing.status === 'cancelled' ? governing.renewsAt : null,
    usage,
    unlock,
    upgradeTo: paidPlanKey ? plans.recommendedUpgradeFor(paidPlanKey) : null,
    paymentMode: plans.paymentMode(),
  };
}

/**
 * What to show the first time somebody loads the dashboard after their plan
 * started: only the perks that are new to them, each pointing at the place in
 * the dashboard it actually lives.
 *
 * For a first purchase that is the whole plan. For an upgrade it is strictly
 * the difference, so the step up they paid for reads as a step up rather than
 * as a list they have seen before -- which is also the honest version, because
 * they already had the rest.
 */
async function describeUnlock(subscription, history = []) {
  const plan = plans.planFor(subscription.planKey);
  if (!plan) return null;

  // Which plan they came from. `previousSubscriptionId` is written when the
  // plan was chosen; falling back to the most recent superseded row covers a
  // subscription created before that field existed, or by an admin by hand.
  const previous = subscription.previousSubscriptionId
    ? history.find((s) => s.id === subscription.previousSubscriptionId)
    : history.find((s) => s.id !== subscription.id && s.status === 'expired');

  const fromPlan = previous ? plans.planFor(previous.planKey) : null;
  const isUpgrade = Boolean(fromPlan) && plan.rank > fromPlan.rank;

  const gained = fromPlan
    ? plans.gainedEntitlements(fromPlan.key, plan.key)
    : plans.entitlementsFor(plan.key);

  return {
    subscriptionId: subscription.id,
    planKey: plan.key,
    planName: plan.name,
    fromPlanName: fromPlan ? fromPlan.name : null,
    isUpgrade,
    // Only the ones with somewhere to send them. A perk line that is not a
    // link is a claim; one that is, is a thing they can go and look at.
    gained: gained.map((e) => ({ key: e.key, label: e.label, surface: e.surface })),
    // Managed and Unlimited can raise a request; Basic cannot, so the second
    // action is offered only where it leads somewhere.
    canRaiseRequest: plan.updateRequestsPerMonth !== 0,
  };
}

/**
 * The shape a screen renders when there is no client to speak of -- a staff
 * account looking at its own membership, which it does not have. A null here
 * would mean every caller needs a branch before it can read a field.
 */
function emptyState() {
  return {
    clientId: null,
    subscription: null,
    pendingSubscription: null,
    scheduledSubscription: null,
    planKey: null,
    plan: null,
    effectivePlanKey: null,
    entitlements: [],
    locked: [],
    grandfathered: false,
    needsPlan: false,
    awaitingPayment: false,
    pastDue: false,
    endingAt: null,
    usage: {
      unlimited: false, included: null, used: 0, extraUsed: 0,
      remaining: null, periodStart: null, resetsAt: null,
    },
    unlock: null,
    upgradeTo: null,
    paymentMode: plans.paymentMode(),
  };
}

/**
 * The welcome email, sent once per client and never again.
 *
 * Two triggers reach this: a client account being created, and the first
 * sign-in of a client who predates the whole feature. Both call it, and the
 * stamp is what makes the second one harmless -- somebody who was mailed on
 * signup does not get a second copy the first time they log in.
 *
 * `existingFreeClient` is derived rather than passed: an account that already
 * existed before this shipped has had no welcome email and has signed in
 * before, and that is exactly the person who needs the line explaining why a
 * site that has been free now needs a plan. A brand new client does not, and
 * telling them their site used to be free would be nonsense.
 *
 * Never throws. An account that was created must not be reported as failed
 * because an inbox was unreachable.
 */
async function sendWelcome(client, { reason = 'signup' } = {}) {
  if (!client || client.role !== 'client' || !client.email) return false;
  if (client.welcomeEmailSentAt) return false;

  try {
    const firstName = String(client.name || '').trim().split(/\s+/)[0] || null;
    const mailer = require('./mailer');
    const messages = require('./emailMessages');

    await mailer.sendTemplate({
      to: client.email,
      message: messages.welcomeWithPlans({
        firstName,
        existingFreeClient: reason === 'first_login',
      }),
      template: 'welcome_with_plans',
      entity: 'user',
      entityId: client.id,
      // The queue refuses to send the same key twice, so two requests racing
      // for a client's first login produce one message rather than two.
      dedupeKey: `welcome-plans:${client.id}`,
    });

    await db.update('users', client.id, { welcomeEmailSentAt: new Date().toISOString() });
    await events.log('welcome_email_sent', { clientId: client.id, metadata: { reason } });
    return true;
  } catch (err) {
    console.error(`[membership] could not send the welcome email to ${client.id}: ${err.message}`);
    return false;
  }
}

/** How long before a renewal the reminder goes out. */
const REMINDER_DAYS = 7;

/**
 * Tell clients on a multi-month plan that it renews in a week.
 *
 * Only the 3, 6 and 12 month periods, because those are the ones paid upfront:
 * somebody who handed over $278.40 in January should not meet the same request
 * in December without warning. A monthly plan is its own reminder, and mailing
 * one every four weeks would be nagging.
 *
 * Rides on ordinary API traffic the way the outbox sweep does, so a deployment
 * where nobody set up a scheduler still sends them. Throttled to once an hour,
 * because a renewal a week away does not get closer any faster than that.
 */
let lastReminderSweep = 0;
let remindersRunning = false;

async function maybeSweepRenewals() {
  if (remindersRunning) return;
  if (Date.now() - lastReminderSweep < 60 * 60 * 1000) return;
  remindersRunning = true;
  lastReminderSweep = Date.now();
  try {
    await sendRenewalReminders();
  } catch (err) {
    console.error(`[membership] renewal reminders failed: ${err.message}`);
  }
  // A scheduled downgrade coming due is checked on the same tick. Separately
  // caught, because a mail transport being down must not also stop a client's
  // plan change from being noticed.
  try {
    await promoteScheduled();
  } catch (err) {
    console.error(`[membership] scheduled changes failed: ${err.message}`);
  } finally {
    remindersRunning = false;
  }
}

async function sendRenewalReminders(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const windowEnd = new Date(at.getTime() + REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = at.toISOString();

  const due = await db.filter('subscriptions', (s) => (
    s.status === 'active'
    // Monthly plans are excluded here rather than filtered out later, so a
    // reading of this line tells you who is in scope.
    && Number(s.period) > 1
    && !s.renewalReminderSentAt
    && s.renewsAt
    && String(s.renewsAt) > nowIso
    && String(s.renewsAt) <= windowEnd
  ));

  let sent = 0;
  for (const subscription of due) {
    try {
      const client = await db.find('users', subscription.clientId);
      if (!client?.email) continue;

      const plan = plans.planFor(subscription.planKey);
      const price = plan ? plans.priceFor(plan.monthlyUsd, subscription.period) : null;

      const mailer = require('./mailer');
      const messages = require('./emailMessages');

      await mailer.sendTemplate({
        to: client.email,
        message: messages.renewalReminder({
          clientName: client.name,
          planName: plan ? plan.name : subscription.planKey,
          periodLabel: price ? price.label : `${subscription.period} months`,
          amountUsd: Number(subscription.amountUsd || 0),
          renewsAt: subscription.renewsAt,
        }),
        template: 'renewal_reminder',
        entity: 'subscription',
        entityId: subscription.id,
        dedupeKey: `renewal-reminder:${subscription.id}:${String(subscription.renewsAt).slice(0, 10)}`,
      });

      // Stamped after the send and before anything else, so a crash in the
      // loop costs one reminder rather than sending the rest of them twice.
      await db.update('subscriptions', subscription.id, {
        renewalReminderSentAt: new Date().toISOString(),
      });
      sent += 1;
    } catch (err) {
      console.error(`[membership] could not remind ${subscription.id}: ${err.message}`);
    }
  }

  return sent;
}

/**
 * Move a scheduled downgrade into the payment queue once the period it was
 * waiting on has run out.
 *
 * A downgrade is chosen today and starts later, so something has to notice
 * "later" arriving. Without this the row sits as `scheduled` forever and the
 * client stays on the plan they asked to leave -- the opposite failure from
 * starting it early, and just as wrong.
 *
 * Only the status changes. The admin still collects the money and still
 * confirms it, exactly as for any other plan, because under
 * PAYMENT_MODE=manual nothing starts a billing period without a human saying
 * the money arrived.
 *
 * Rides on ordinary API traffic the way the outbox sweep does, so a deployment
 * where nobody set up a scheduler still runs it.
 */
async function promoteScheduled(now = new Date()) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();

  const due = await db.filter('subscriptions', (s) => (
    s.status === 'scheduled' && s.startsAt && String(s.startsAt) <= at
  ));

  let promoted = 0;
  for (const subscription of due) {
    try {
      const governing = await governingFor(subscription.clientId, now);
      const active = governing && governing.status === 'active' ? governing : null;

      // Already on the plan they asked to move to. Nothing to collect and
      // nothing to start.
      if (active && active.planKey === subscription.planKey) {
        await db.update('subscriptions', subscription.id, { status: 'expired', updatedAt: at });
        continue;
      }

      // They moved to some other plan in the meantime -- the row this
      // downgrade was queued behind is no longer the one governing them, so
      // they upgraded or renewed after choosing it. The choice is stale, and
      // billing them for a plan they changed their mind about months ago would
      // be worse than dropping it.
      //
      // Keyed on the subscription it was queued behind rather than on the plan
      // key: the plan they are on at the end of a six month period is normally
      // the *same* plan the downgrade is waiting for to finish, so comparing
      // plan keys here would drop every legitimate downgrade.
      if (subscription.previousSubscriptionId && active
        && active.id !== subscription.previousSubscriptionId) {
        await db.update('subscriptions', subscription.id, { status: 'expired', updatedAt: at });
        continue;
      }

      // Claimed, not just written: this sweep rides on ordinary API traffic,
      // so two requests arriving together both run it. Without the claim they
      // both promote the same row and the team is told twice that one
      // client's plan is due.
      const promotedRow = await db.claimStatus(
        'subscriptions', subscription.id, 'scheduled', { status: 'pending_payment', updatedAt: at },
      );
      if (!promotedRow) continue;

      await events.log('scheduled_change_due', {
        clientId: subscription.clientId,
        metadata: {
          subscriptionId: subscription.id,
          planKey: subscription.planKey,
          startsAt: subscription.startsAt,
        },
      });
      promoted += 1;
    } catch (err) {
      console.error(`[membership] could not promote ${subscription.id}: ${err.message}`);
    }
  }

  return promoted;
}

/**
 * What an upgrade credits them for the days they already paid for.
 *
 * UPGRADE_BILLING, as decided: the unused part of the plan they are on comes
 * off the price of the plan they are moving to, and the new period starts when
 * the new payment is confirmed. A client three months into a six month Managed
 * plan has about half of $96.90 left, and it would be indefensible to charge
 * them the full Unlimited price and keep it.
 *
 * Prorated by day rather than by month, because an upgrade happens on the day
 * somebody decides, not on a billing boundary. Clamped at both ends: a clock
 * skew must never produce a negative credit, and no credit can exceed what
 * they actually paid.
 *
 * Returns 0 when there is nothing to credit -- no active plan, no dates, or a
 * period that has already run out.
 */
function creditFor(subscription, now = new Date()) {
  if (!subscription) return 0;
  if (!governs(subscription, now)) return 0;
  if (!subscription.startedAt || !subscription.renewsAt) return 0;

  const start = new Date(subscription.startedAt).getTime();
  const end = new Date(subscription.renewsAt).getTime();
  const at = (now instanceof Date ? now : new Date(now)).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;

  const paid = Number(subscription.amountUsd || 0);
  if (!(paid > 0)) return 0;

  const remaining = end - Math.max(at, start);
  if (remaining <= 0) return 0;

  const ratio = Math.min(1, remaining / (end - start));
  return plans.money(Math.min(paid, Math.max(0, paid * ratio)));
}

/**
 * Price an upgrade or a new plan for one client, showing the working.
 *
 * The client sees every line of this before they agree to anything, and so
 * does the admin before payment details go out -- the figure is calculated
 * rather than typed, but a human still signs it off, because real cases get
 * messy in ways arithmetic does not cover.
 */
async function quoteFor(clientId, planKey, period, now = new Date()) {
  if (!plans.isPlanKey(planKey)) throw new Error(`Unknown plan: ${planKey}`);
  if (!plans.isPeriod(period)) throw new Error(`Unknown billing period: ${period}`);

  const months = Number(period);
  const list = plans.amountFor(planKey, months);
  const current = clientId ? await governingFor(clientId, now) : null;

  const currentPlan = current ? plans.planFor(current.planKey) : null;
  const nextPlan = plans.planFor(planKey);

  const kind = !currentPlan
    ? 'new'
    : currentPlan.key === planKey
      ? 'renewal'
      : nextPlan.rank > currentPlan.rank
        ? 'upgrade'
        : 'downgrade';

  // Credit applies to an upgrade and to nothing else.
  //
  // A renewal is not credited, because the period being credited is the one
  // they are about to use. A *downgrade* is not credited either, and that is
  // the case worth spelling out: somebody three months into six months of
  // Managed has about $49 of value left, and crediting that against $9 of
  // Basic would hand them a free month and quietly burn the other $40. So a
  // downgrade is not bought now at all -- it is scheduled, the plan they paid
  // for runs to the end of the period they paid for, and the cheaper one
  // starts the day after. Nobody loses money they already handed over.
  const credit = kind === 'upgrade' ? creditFor(current, now) : 0;
  const scheduled = kind === 'downgrade';

  return {
    planKey,
    planName: nextPlan.name,
    period: months,
    currency: plans.CURRENCY,
    listAmountUsd: list,
    creditUsd: credit,
    amountUsd: plans.money(Math.max(0, list - credit)),
    kind,
    // A downgrade is paid for when it starts, not today. A screen reads this
    // to say "nothing to pay now" rather than quoting a price for a plan that
    // has not begun.
    scheduled,
    startsAt: scheduled ? (current?.renewsAt || null) : null,
    dueNowUsd: scheduled ? 0 : plans.money(Math.max(0, list - credit)),
    from: currentPlan
      ? {
        planKey: currentPlan.key,
        planName: currentPlan.name,
        subscriptionId: current.id,
        renewsAt: current.renewsAt || null,
      }
      : null,
  };
}

/**
 * Confirm the money arrived, and start the plan.
 *
 * The single place a subscription ever becomes `active`. Everything that makes
 * the "one active plan per client" promise true lives here rather than in the
 * routes that call it, so there is one order of operations to get right
 * instead of one per caller.
 *
 * That order matters literally: the plan being replaced is retired *before*
 * the new one is activated. Postgres carries a partial unique index on
 * (client_id) WHERE status = 'active', so doing it the other way round is
 * refused outright -- which is the index doing its job, but a refusal in the
 * middle of confirming a payment is not where anybody wants to find out.
 *
 * Idempotent by status: a subscription that is already active is returned
 * unchanged rather than restarted, so a double-clicked button or a replayed
 * approval cannot move somebody's renewal date a month into the future.
 */
async function activate(subscriptionId, { byUserId = 'system', now = new Date() } = {}) {
  const subscription = await db.find('subscriptions', subscriptionId);
  if (!subscription) throw new Error('No such subscription.');

  if (subscription.status === 'active') {
    return { subscription, previous: null, kind: 'renewal', alreadyActive: true };
  }
  // A scheduled downgrade is not a payment waiting to be confirmed. Activating
  // it here would start the cheaper plan today and expire the one underneath
  // it, throwing away the days the client already paid for -- the exact thing
  // scheduling exists to prevent. It becomes payable when `promoteScheduled`
  // moves it, on the day the paid period runs out.
  if (subscription.status === 'scheduled') {
    throw new Error(
      'That plan is scheduled to start when the current period ends, so there is nothing to confirm yet.',
    );
  }
  if (subscription.status !== 'pending_payment') {
    throw new Error(`That plan is ${subscription.status}, so there is no payment to confirm.`);
  }

  const at = now instanceof Date ? now : new Date(now);
  const startedAt = at.toISOString();
  const renewsAt = plans.renewalDate(at, subscription.period).toISOString();

  // What they were on, if anything. Read before anything is written, because
  // the whole point of the next few lines is that it stops being findable.
  const previous = await activeFor(subscription.clientId);

  const previousPlan = previous ? plans.planFor(previous.planKey) : null;
  const nextPlan = plans.planFor(subscription.planKey);
  const kind = !previousPlan
    ? 'new'
    : previousPlan.key === nextPlan.key
      ? 'renewal'
      : nextPlan.rank > previousPlan.rank
        ? 'upgrade'
        : 'downgrade';

  /**
   * Take the subscription out of `pending_payment` first, and only carry on
   * if this call is the one that did it.
   *
   * The status check at the top of this function is a read, and a read is not
   * a lock: two confirmations arriving together both saw `pending_payment`,
   * both decided there was a payment to confirm, and both went on to log the
   * event, write the audit entry and run the side effects. One payment, two
   * of everything. It happens the first time two admins are told the money
   * landed, or a request is retried.
   *
   * So the transition is the claim. Exactly one caller gets the row back; the
   * rest are told it is already running, which is the truthful answer and the
   * same one a second click has always received.
   */
  if (previous) {
    // `expired`, not `cancelled`. Cancelled means the client asked us to stop,
    // and it grants its perks until the period runs out (see `governs`) --
    // which here would leave two plans granting at once. This one was
    // superseded by a plan they just paid for, and the new one is what
    // governs from this moment.
    //
    // Still done before the activation below, because the partial unique
    // index on (client_id) WHERE status = 'active' refuses the other order
    // outright. A caller that goes on to lose the claim has expired a row the
    // winner was about to expire anyway, so the end state is the same.
    await db.update('subscriptions', previous.id, {
      status: 'expired',
      cancelledAt: startedAt,
      updatedAt: startedAt,
    });
  }

  const activated = await db.claimStatus('subscriptions', subscription.id, 'pending_payment', {
    status: 'active',
    startedAt,
    renewsAt,
    markedPaidAt: startedAt,
    markedPaidBy: byUserId,
    updatedAt: startedAt,
  });

  // Somebody else confirmed this payment between the read at the top and
  // here. Theirs is the one that counted; this call reports the running plan
  // and does none of the work again.
  if (!activated) {
    return {
      subscription: await db.find('subscriptions', subscriptionId),
      previous: null,
      kind: 'renewal',
      alreadyActive: true,
    };
  }

  await events.log('payment_confirmed', {
    clientId: subscription.clientId,
    actorId: byUserId,
    metadata: {
      subscriptionId: subscription.id,
      planKey: subscription.planKey,
      period: subscription.period,
      amountUsd: Number(subscription.amountUsd || 0),
      kind,
    },
  });

  if (kind === 'upgrade' || kind === 'downgrade') {
    await events.log(kind === 'upgrade' ? 'upgraded' : 'downgraded', {
      clientId: subscription.clientId,
      actorId: byUserId,
      metadata: {
        from: previousPlan.key,
        to: nextPlan.key,
        amountUsd: Number(subscription.amountUsd || 0),
        creditUsd: subscription.creditUsd == null ? 0 : Number(subscription.creditUsd),
      },
    });
  }

  await sendConfirmation(activated, { previous, kind });

  return { subscription: activated, previous, kind, alreadyActive: false };
}

/**
 * The "your plan is running" email, sent once per subscription.
 *
 * Guarded three ways, because a client reading the same confirmation twice has
 * a reason to wonder whether they were charged twice: the stamp is checked
 * before the send, written straight after it, and the queue carries a dedupe
 * key derived from the subscription id so two processes racing still produce
 * one message. See the UNIQUE index on outbox.dedupe_key.
 *
 * Never throws. The payment is confirmed and the plan is running whatever the
 * mail transport is doing; an unreachable inbox is not a reason to fail the
 * thing that already happened.
 */
async function sendConfirmation(subscription, { previous = null, kind = 'new' } = {}) {
  if (!subscription || subscription.confirmationSentAt) return false;

  try {
    const client = await db.find('users', subscription.clientId);
    if (!client?.email) return false;

    const plan = plans.planFor(subscription.planKey);
    const price = plan ? plans.priceFor(plan.monthlyUsd, subscription.period) : null;
    const previousPlan = previous ? plans.planFor(previous.planKey) : null;

    // Only what is new to them. Reading a client their whole plan after an
    // upgrade makes the step up they just paid for look like nothing changed.
    const perks = (kind === 'upgrade' || kind === 'downgrade') && previousPlan
      ? plans.gainedEntitlements(previousPlan.key, subscription.planKey)
      : plans.entitlementsFor(subscription.planKey);

    const mailer = require('./mailer');
    const messages = require('./emailMessages');

    await mailer.sendTemplate({
      to: client.email,
      message: messages.planConfirmed({
        clientName: client.name,
        planName: plan ? plan.name : subscription.planKey,
        periodLabel: price ? price.label : `${subscription.period} months`,
        amountUsd: Number(subscription.amountUsd || 0),
        renewsAt: subscription.renewsAt,
        creditUsd: subscription.creditUsd == null ? 0 : Number(subscription.creditUsd),
        fromPlanName: previousPlan ? previousPlan.name : null,
        // Short labels: the confirmation lays these out as a two-column grid,
        // which has room for keywords rather than sentences.
        perks: perks.map((p) => p.short || p.label),
      }),
      template: 'plan_confirmed',
      entity: 'subscription',
      entityId: subscription.id,
      dedupeKey: `plan-confirmed:${subscription.id}`,
    });

    await db.update('subscriptions', subscription.id, {
      confirmationSentAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.error(`[membership] could not send the confirmation for ${subscription.id}: ${err.message}`);
    return false;
  }
}

/**
 * Stop a plan renewing.
 *
 * Does not switch anything off. The client paid for a period and that period
 * runs to its end -- `governs` keeps a cancelled subscription granting until
 * `renewsAt`, and the playbook promises exactly that. What changes today is
 * that it will not renew.
 *
 * The reason is optional and free of consequence. A dropdown that must be
 * answered before somebody may leave is a toll gate, and it produces answers
 * nobody should plan on.
 */
async function cancel(subscriptionId, { byUserId, reason = null, now = new Date() } = {}) {
  const subscription = await db.find('subscriptions', subscriptionId);
  if (!subscription) throw new Error('No such subscription.');
  if (subscription.status === 'cancelled') {
    return { subscription, alreadyCancelled: true };
  }
  if (subscription.status !== 'active' && subscription.status !== 'past_due') {
    throw new Error(`That plan is ${subscription.status}, so there is nothing to cancel.`);
  }

  const at = (now instanceof Date ? now : new Date(now)).toISOString();

  const cancelled = await db.update('subscriptions', subscription.id, {
    status: 'cancelled',
    cancelledAt: at,
    cancelReason: reason ? String(reason).slice(0, 200) : null,
    updatedAt: at,
  });

  // Anything they had chosen and not paid for goes with it. Leaving a pending
  // upgrade behind a cancellation would put a client who is leaving on an
  // admin's list of people to chase for money -- and leaving a *scheduled*
  // downgrade behind one would start a plan, weeks later, for somebody who had
  // already told us they were finished.
  for (const other of await historyFor(subscription.clientId)) {
    if (other.id !== subscription.id && ['pending_payment', 'scheduled'].includes(other.status)) {
      await db.update('subscriptions', other.id, { status: 'expired', updatedAt: at });
    }
  }

  await events.log('cancelled', {
    clientId: subscription.clientId,
    actorId: byUserId,
    metadata: {
      planKey: subscription.planKey,
      reason: reason || null,
      endsAt: subscription.renewsAt || null,
    },
  });

  return { subscription: cancelled, alreadyCancelled: false };
}

/**
 * They would like their website files.
 *
 * We prepare the files. We do not migrate the site, and we do not set it up
 * anywhere else -- the playbook is explicit, and so is what the client is
 * shown before they ask. Recorded rather than handled in a conversation,
 * because "did anyone send those files" is a question that otherwise gets
 * answered from memory.
 */
async function requestHandover(subscriptionId, { byUserId, now = new Date() } = {}) {
  const subscription = await db.find('subscriptions', subscriptionId);
  if (!subscription) throw new Error('No such subscription.');
  if (subscription.handoverRequestedAt) {
    return { subscription, alreadyRequested: true };
  }

  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const updated = await db.update('subscriptions', subscription.id, {
    handoverRequestedAt: at,
    updatedAt: at,
  });

  await events.log('handover_requested', {
    clientId: subscription.clientId,
    actorId: byUserId,
    metadata: { planKey: subscription.planKey, endsAt: subscription.renewsAt || null },
  });

  return { subscription: updated, alreadyRequested: false };
}

/**
 * One subscription, in the shape a screen reads.
 *
 * The price is recomputed from lib/plans.js for display alongside the amount
 * actually charged, so a client who was quoted a credited figure sees both
 * "Unlimited, $29/month" and what they really paid without either number
 * having been typed anywhere.
 */
function describe(subscription) {
  if (!subscription) return null;
  const plan = plans.planFor(subscription.planKey);
  const price = plan ? plans.priceFor(plan.monthlyUsd, subscription.period) : null;

  return {
    id: subscription.id,
    clientId: subscription.clientId,
    planKey: subscription.planKey,
    planName: plan ? plan.name : subscription.planKey,
    period: subscription.period,
    periodLabel: price ? price.label : `${subscription.period} months`,
    status: subscription.status,
    currency: plans.CURRENCY,
    // What they were actually asked for, which is the figure that matters on a
    // billing page.
    amountUsd: Number(subscription.amountUsd || 0),
    // What the plan lists at, so an upgrade credit is visible as a difference
    // rather than as an unexplained number.
    listAmountUsd: price ? price.total : null,
    creditUsd: subscription.creditUsd == null ? null : Number(subscription.creditUsd),
    // Only ever set on a scheduled row: the day a downgrade may begin, which
    // is the day the period they already paid for runs out.
    startsAt: subscription.startsAt || null,
    startedAt: subscription.startedAt || null,
    renewsAt: subscription.renewsAt || null,
    cancelledAt: subscription.cancelledAt || null,
    cancelReason: subscription.cancelReason || null,
    handoverRequestedAt: subscription.handoverRequestedAt || null,
    markedPaidAt: subscription.markedPaidAt || null,
    unlockSeenAt: subscription.unlockSeenAt || null,
    previousSubscriptionId: subscription.previousSubscriptionId || null,
  };
}

/**
 * Whether a client's current membership includes an entitlement.
 *
 * The single question every server-side guard asks. Takes the state object so
 * a route that has already loaded it does not read the database twice.
 */
function has(state, entitlementKey) {
  if (!state) return false;
  return state.entitlements.includes(entitlementKey);
}

/**
 * Which ticket categories this client may file under.
 *
 * `null` means every category. Basic is self service, but an outage or a
 * billing question is not a change request and a client whose site is down
 * must always be able to reach us, so Basic keeps those two.
 */
function allowedTicketCategories(state) {
  if (!state || !state.effectivePlanKey) return null;
  const plan = plans.planFor(state.effectivePlanKey);
  return plan ? plan.ticketCategories : null;
}

module.exports = {
  STATUSES,
  enforcedWithoutPlan,
  historyFor,
  currentFor,
  activeFor,
  hasEverPaid,
  governs,
  governingFor,
  emptyState,
  sendWelcome,
  creditFor,
  quoteFor,
  activate,
  REMINDER_DAYS,
  maybeSweepRenewals,
  sendRenewalReminders,
  promoteScheduled,
  cancel,
  requestHandover,
  sendConfirmation,
  describeUnlock,
  usageWindow,
  usageId,
  usageFor,
  stateFor,
  describe,
  has,
  allowedTicketCategories,
};
