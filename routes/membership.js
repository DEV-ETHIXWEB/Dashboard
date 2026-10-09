'use strict';

/**
 * What plan a client is on, and what it unlocks.
 *
 * Deliberately **not** mounted behind requirePage('billing'). An admin can
 * switch a client's Billing section off, and that is a decision about a page,
 * not about whether the client is allowed to know what plan they are on: the
 * "choose a plan to keep your site hosted with us" banner and the first-login
 * modal appear on the dashboard, which everybody keeps. Gating this would make
 * the banner 403 for exactly the clients it most needs to reach.
 *
 * Reads only, for now. Choosing a plan, marking it paid, upgrading and
 * cancelling arrive in the steps after this one.
 */

const express = require('express');
const router = express.Router();

const { db } = require('../db/setup');
const { requireAuth, requireCSRF, requireRole, audit, notify } = require('../middleware/auth');
const approvals = require('../utils/approvals');
const plans = require('../lib/plans');
const subscriptions = require('../utils/subscriptions');
const events = require('../utils/membershipEvents');
const upsell = require('../utils/upsell');
const roles = require('../utils/roles');
const slack = require('../utils/slack');
const live = require('../utils/liveBus');

router.use(requireAuth);

/**
 * Whose membership this request is about.
 *
 * A client is only ever told about themselves, whatever they put in the query
 * string -- the `clientId` parameter is read for staff and ignored for
 * everybody else, rather than trusted and then checked. Staff reading a client
 * they have no business reading is already governed by their role; what must
 * not be possible is one client reading another, and the shape of this
 * function is what makes that unreachable rather than merely forbidden.
 */
async function subjectFor(req) {
  if (req.user.role === 'client') return req.user;

  if (!['admin', 'sales', 'project_manager'].includes(req.user.role)) return null;

  // A write names its client in the body, a read in the query string. Both are
  // read only for staff, and a client's own record is returned above before
  // either is looked at -- so this is not "asked and refused", it is a
  // parameter a client's request never reaches.
  const requested = req.query.clientId || req.body?.clientId || null;
  if (!requested) return null;
  const client = await db.find('users', requested);
  return client && client.role === 'client' ? client : null;
}

/**
 * The one read the whole feature hangs off: plan, status, renewal date, what
 * is unlocked, what is locked, and this month's allowance.
 */
router.get('/status', async (req, res, next) => {
  try {
    const subject = await subjectFor(req);

    // Staff with no client named are not an error. They have no membership of
    // their own -- plans are a client thing -- and the screens that call this
    // for themselves need a shape they can render, not a 400.
    if (!subject) {
      return res.json({
        membership: null,
        reason: req.user.role === 'client' ? 'no_account' : 'not_a_client',
      });
    }

    const state = await subscriptions.stateFor(subject);
    res.json({ membership: state });
  } catch (err) {
    next(err);
  }
});

/**
 * The plan history behind the current one.
 *
 * Separate from /status because it is only read on the billing page, and
 * /status is read on nearly every page a client opens.
 */
router.get('/history', async (req, res, next) => {
  try {
    const subject = await subjectFor(req);
    if (!subject) return res.json({ subscriptions: [] });

    const history = await subscriptions.historyFor(subject.id);
    res.json({ subscriptions: history.map((s) => subscriptions.describe(s)) });
  } catch (err) {
    next(err);
  }
});

/**
 * The funnel, for staff only.
 *
 * A client has no use for the record of how many upgrade prompts they were
 * shown, and being able to read it back would be unsettling rather than
 * useful. This is the screen that answers "does the upsell convert or just
 * annoy people".
 */
router.get('/events', async (req, res, next) => {
  try {
    if (!['admin', 'project_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Membership activity is not part of your role.' });
    }

    const requested = req.query.clientId || null;
    if (requested) {
      return res.json({ events: await events.forClient(requested, { limit: 500 }) });
    }

    // Newest 500, chosen by the database. Reading the whole event table and
    // throwing away all but the last page of it is the sort of thing that
    // works perfectly until the table is a year old.
    res.json({
      events: await db.where('membership_events', {}, { orderBy: 'createdAt', limit: 500 }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * What a plan would cost this client right now, credit included.
 *
 * Read-only and deliberately its own endpoint: the plans modal asks for it as
 * the client moves the period switcher, long before anybody commits to
 * anything, and nothing here writes a row.
 */
router.get('/quote', async (req, res, next) => {
  try {
    const subject = await subjectFor(req);
    if (!subject) return res.status(400).json({ error: 'No client account to price a plan for.' });

    const { planKey, period } = req.query;
    if (!plans.isPlanKey(planKey)) return res.status(400).json({ error: 'Pick one of the three plans.' });
    if (!plans.isPeriod(period)) return res.status(400).json({ error: 'Pick a billing period of 1, 3, 6 or 12 months.' });

    res.json({ quote: await subscriptions.quoteFor(subject.id, planKey, Number(period)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Choose a plan.
 *
 * Creates a subscription in `pending_payment` and nothing else. It unlocks
 * nothing, cancels nothing and charges nothing -- under PAYMENT_MODE=manual
 * the money arrives by bank transfer and an admin confirms it, and until they
 * do, a client who is already on a plan stays on it. A client must never be
 * between two plans and covered by neither.
 */
router.post('/select', requireCSRF, async (req, res, next) => {
  try {
    const subject = await subjectFor(req);
    if (!subject) return res.status(400).json({ error: 'No client account to put a plan on.' });

    const { planKey, period } = req.body || {};
    if (!plans.isPlanKey(planKey)) return res.status(400).json({ error: 'Pick one of the three plans.' });
    if (!plans.isPeriod(period)) return res.status(400).json({ error: 'Pick a billing period of 1, 3, 6 or 12 months.' });

    const months = Number(period);
    const quote = await subscriptions.quoteFor(subject.id, planKey, months);

    // Pressing the button twice, or a flaky connection retrying the request,
    // must not produce two things for an admin to chase. An identical choice
    // not yet started is answered with the row that already exists.
    //
    // Both open statuses count here: `pending_payment` for something being
    // paid for now, and `scheduled` for a downgrade that starts later. A
    // client has at most one open choice either way.
    const existing = (await subscriptions.historyFor(subject.id))
      .find((s) => ['pending_payment', 'scheduled'].includes(s.status));
    if (existing && existing.planKey === planKey && Number(existing.period) === months) {
      return res.json({ subscription: subscriptions.describe(existing), quote, alreadyChosen: true });
    }

    // A different choice replaces the old one rather than adding to it:
    // somebody who picked Managed and then picked Unlimited has chosen
    // Unlimited, and leaving both would send two sets of payment details.
    if (existing) {
      await db.update('subscriptions', existing.id, {
        status: 'expired', cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();

    /**
     * A downgrade is chosen today and starts when the period they already paid
     * for runs out -- which is what the client is shown before they confirm,
     * and what `quote.scheduled` means.
     *
     * So it is written as `scheduled`, not `pending_payment`, and the
     * difference is the whole point. A `pending_payment` row goes onto the
     * admin's list of money to collect and can be marked paid, and marking it
     * paid starts the plan *today* and expires the one underneath it. Doing
     * that to a downgrade would bill a client who was just told there was
     * nothing to pay, and throw away the months of the dearer plan they had
     * already handed over money for.
     *
     * `amountUsd` is the list price, because that is what they will owe when
     * it does start. Nothing is collected until utils/subscriptions.js
     * promotes the row on `startsAt`.
     */
    const subscription = await db.insert('subscriptions', {
      clientId: subject.id,
      planKey,
      period: months,
      amountUsd: quote.amountUsd,
      creditUsd: quote.creditUsd > 0 ? quote.creditUsd : null,
      previousSubscriptionId: quote.from ? quote.from.subscriptionId : null,
      status: quote.scheduled ? 'scheduled' : 'pending_payment',
      startsAt: quote.scheduled ? quote.startsAt : null,
      createdBy: req.user.id,
      createdAt: now,
      updatedAt: now,
    });

    await events.log('plan_selected', {
      clientId: subject.id,
      actorId: req.user.id,
      metadata: {
        planKey, period: months, kind: quote.kind,
        amountUsd: quote.amountUsd, creditUsd: quote.creditUsd,
        from: quote.from ? quote.from.planKey : null,
      },
    });
    await audit(req.user.id, 'create', 'subscription', subscription.id, {
      clientId: subject.id, planKey, period: months, amountUsd: quote.amountUsd,
    });

    await announceChoice(subject, quote);

    res.locals.liveAudience = [subject.id];
    live.publish('membership', { to: [subject.id] });

    res.status(201).json({ subscription: subscriptions.describe(subscription), quote });
  } catch (err) {
    next(err);
  }
});

/**
 * Tell the team somebody is waiting on payment details.
 *
 * A choice nobody acts on is a sale lost to an inbox, so this goes to the
 * admins' own alert list *and* to Slack. Neither is allowed to fail the
 * request: the client's choice is recorded either way, and an admin can see it
 * on the Billing page regardless of whether Slack was reachable.
 */
async function announceChoice(client, quote) {
  const money = `${plans.formatUsd(quote.amountUsd)} USD`;
  const period = `${quote.period} month${quote.period === 1 ? '' : 's'}`;

  // A scheduled downgrade has nothing to collect today, and saying "send
  // payment details" would have somebody ask a client for money they were
  // just told they did not owe -- and start the cheaper plan early if they
  // paid it.
  const starts = quote.startsAt
    ? new Date(quote.startsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'the end of the period they paid for';

  const line = quote.scheduled
    ? `${client.name} is moving to ${quote.planName} (${period}) when their `
      + `${quote.from?.planName || 'current'} plan ends on ${starts}. Nothing to collect now -- `
      + `${money} is due then.`
    : quote.creditUsd > 0
      ? `${client.name} chose ${quote.planName} (${period}): `
        + `${money} after ${plans.formatUsd(quote.creditUsd)} credited from ${quote.from?.planName}. Send payment details.`
      : `${client.name} chose ${quote.planName} (${period}), ${money}. Send payment details.`;

  try {
    for (const admin of await roles.listAdmins()) {
      await notify(admin.id, line, 'billing');
    }
  } catch (err) {
    console.error(`[membership] could not alert the team about ${client.id}: ${err.message}`);
  }

  try {
    await slack.notifySlack(line);
  } catch (err) {
    console.error(`[membership] could not post the plan choice to Slack: ${err.message}`);
  }
}

/**
 * Everybody waiting on payment details, newest first.
 *
 * The admin's working list: who chose what, how much to ask for, and how long
 * they have been waiting. A choice nobody acts on is a sale lost to an inbox,
 * so this is a screen rather than something to go looking for.
 */
router.get('/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await db.where('subscriptions', { status: 'pending_payment' });
    const clients = new Map((await db.all('users')).map((u) => [u.id, u]));

    const pending = rows
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map((s) => {
        const client = clients.get(s.clientId);
        return {
          ...subscriptions.describe(s),
          clientName: client?.name || s.clientId,
          clientEmail: client?.email || null,
          chosenAt: s.createdAt || null,
        };
      });

    res.json({ pending });
  } catch (err) {
    next(err);
  }
});

/**
 * Confirm the money arrived.
 *
 * The only way a subscription becomes active under PAYMENT_MODE=manual, and
 * the one irreversible action in this feature -- it starts a billing period,
 * retires the plan they were on and unlocks everything. An admin who has not
 * been vouched for proposes it and a second admin signs it off; see
 * utils/approvals.js and the note on `subscription.markPaid` there.
 */
router.post('/:id/mark-paid', requireCSRF, requireRole('admin'), async (req, res, next) => {
  try {
    const subscription = await db.find('subscriptions', req.params.id);
    if (!subscription) return res.status(404).json({ error: 'No such subscription.' });
    if (subscription.status === 'active') {
      return res.json({ subscription: subscriptions.describe(subscription), alreadyActive: true });
    }
    // A scheduled downgrade is not a payment waiting to be confirmed. The
    // client was told nothing was due now, and the period they paid for runs
    // to its end -- confirming this early would charge them and cut the dearer
    // plan short on the same click.
    if (subscription.status === 'scheduled') {
      const starts = subscription.startsAt
        ? new Date(subscription.startsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'the end of the current period';
      return res.status(409).json({
        error: `That plan starts on ${starts}, when the period they already paid for ends. `
          + 'There is nothing to collect until then.',
      });
    }
    if (subscription.status !== 'pending_payment') {
      return res.status(409).json({
        error: `That plan is ${subscription.status}, so there is no payment to confirm.`,
      });
    }

    const client = await db.find('users', subscription.clientId);
    const planName = plans.planFor(subscription.planKey)?.name || subscription.planKey;
    const amount = `${plans.formatUsd(subscription.amountUsd)} USD`;

    const gate = await approvals.gate(req, res, {
      action: 'subscription.markPaid',
      summary: `Confirm ${amount} from ${client?.name || 'a client'} and start their ${planName} plan`,
      payload: { subscriptionId: subscription.id },
    });
    if (gate.held) return;

    const result = await subscriptions.activate(subscription.id, { byUserId: req.user.id });

    await audit(req.user.id, 'update', 'subscription', subscription.id, {
      clientId: subscription.clientId,
      planKey: subscription.planKey,
      amountUsd: Number(subscription.amountUsd || 0),
      kind: result.kind,
      supersededSubscriptionId: result.previous?.id || null,
    });

    // The client hears it in the app. The confirmation email and the unlock
    // moment come next; this is the part that must not wait on either.
    await notify(
      subscription.clientId,
      `Payment confirmed. You are on ${planName}, and everything it covers is now unlocked.`,
      'billing',
    );

    res.locals.liveAudience = [subscription.clientId];
    live.publish('membership', { to: [subscription.clientId] });
    live.publish('billing', { to: [subscription.clientId] });

    res.json({
      subscription: subscriptions.describe(result.subscription),
      superseded: result.previous ? subscriptions.describe(result.previous) : null,
      kind: result.kind,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Stop a plan renewing.
 *
 * Nothing is switched off today. They paid for a period and that period runs
 * to its end -- the client is told exactly that before they confirm, and the
 * billing page keeps saying it afterwards.
 *
 * As easy to reach as upgrading, and no harder to use. One request, one
 * optional reason, done. There is no second confirmation screen and no form
 * to fill in, because a cancellation that takes three screens is a complaint
 * being written in somebody's head.
 */
router.post('/cancel', requireCSRF, async (req, res, next) => {
  try {
    const subject = await subjectFor(req);
    if (!subject) return res.status(400).json({ error: 'No client account to cancel a plan for.' });

    const active = await subscriptions.currentFor(subject.id);
    if (!active || !['active', 'past_due'].includes(active.status)) {
      return res.status(409).json({ error: 'There is no running plan to cancel.' });
    }

    const result = await subscriptions.cancel(active.id, {
      byUserId: req.user.id,
      reason: req.body?.reason || null,
    });

    await audit(req.user.id, 'update', 'subscription', active.id, {
      clientId: subject.id, action: 'cancel', reason: req.body?.reason || null,
    });

    // The team hears about it. A client who leaves quietly is one nobody got
    // the chance to help, and the playbook is explicit that an unhappy one
    // should reach a person.
    const endsAt = result.subscription.renewsAt;
    const line = `${subject.name} cancelled their ${plans.planFor(active.planKey)?.name || active.planKey} plan`
      + `${endsAt ? `, ending ${new Date(endsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}.`
      + `${req.body?.reason ? ` Reason given: ${req.body.reason}.` : ''}`;
    for (const admin of await roles.listAdmins()) {
      await notify(admin.id, line, 'billing');
    }
    try { await slack.notifySlack(line); } catch { /* Slack is not the record. */ }

    res.locals.liveAudience = [subject.id];
    live.publish('membership', { to: [subject.id] });

    res.json({ subscription: subscriptions.describe(result.subscription) });
  } catch (err) {
    next(err);
  }
});

/**
 * "Please prepare my website files."
 *
 * We prepare the files. We do not migrate the site and we do not set it up
 * anywhere else -- the client is shown that sentence before they ask, so this
 * endpoint records a request whose terms they have already read.
 */
router.post('/handover', requireCSRF, async (req, res, next) => {
  try {
    const subject = await subjectFor(req);
    if (!subject) return res.status(400).json({ error: 'No client account to prepare files for.' });

    const history = await subscriptions.historyFor(subject.id);
    const target = history.find((s) => s.status === 'cancelled') || history[0];
    if (!target) return res.status(409).json({ error: 'There is no plan on this account.' });

    const result = await subscriptions.requestHandover(target.id, { byUserId: req.user.id });

    if (!result.alreadyRequested) {
      const line = `${subject.name} asked for their website files. Prepare the files; we do not migrate the site.`;
      for (const admin of await roles.listAdmins()) {
        await notify(admin.id, line, 'billing');
      }
      try { await slack.notifySlack(line); } catch { /* Slack is not the record. */ }
      await audit(req.user.id, 'create', 'handover', target.id, { clientId: subject.id });
    }

    res.locals.liveAudience = [subject.id];
    live.publish('membership', { to: [subject.id] });

    res.json({
      requestedAt: result.subscription.handoverRequestedAt,
      alreadyRequested: result.alreadyRequested,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The upgrade prompt this client should see on their dashboard, or null.
 *
 * Read on dashboard load. Deliberately a read: asking does not count as
 * showing, because a tab opened in the background and never looked at would
 * otherwise spend the week's one prompt. The browser calls `/upsell/shown`
 * when it actually puts the thing on screen.
 */
router.get('/upsell', async (req, res, next) => {
  try {
    if (req.user.role !== 'client') return res.json({ prompt: null });
    res.json({ prompt: await upsell.promptFor(req.user) });
  } catch (err) {
    next(err);
  }
});

/**
 * What the client did with it.
 *
 * `shown` is sent when it appears, not when it is fetched. The other three are
 * the ways out: two of them decline, and neither is phrased as a confession.
 */
router.post('/upsell/:action', requireCSRF, async (req, res, next) => {
  try {
    if (req.user.role !== 'client') return res.json({ ok: true });

    const messageKey = typeof req.body?.messageKey === 'string' ? req.body.messageKey : null;

    switch (req.params.action) {
      case 'shown':
        await upsell.markShown(req.user, { messageKey, trigger: req.body?.trigger || 'weekly' });
        return res.json({ ok: true });
      case 'dismissed': {
        const streak = await upsell.markDismissed(req.user, { messageKey });
        return res.json({ ok: true, streak });
      }
      case 'snoozed': {
        const until = await upsell.markSnoozed(req.user, { messageKey });
        return res.json({ ok: true, until });
      }
      case 'clicked':
        await upsell.markClicked(req.user, { messageKey });
        return res.json({ ok: true });
      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * The client has seen what their plan unlocked.
 *
 * Owed once per subscription, so the stamp lives on the subscription row
 * rather than on the account: an upgrade six months later is a second unlock
 * moment and should be shown, and a flag on the user would have swallowed it.
 */
router.post('/unlock-seen', requireCSRF, async (req, res, next) => {
  try {
    if (req.user.role !== 'client') return res.json({ ok: true });

    const active = await subscriptions.activeFor(req.user.id);
    if (!active || active.unlockSeenAt) return res.json({ ok: true });

    await db.update('subscriptions', active.id, { unlockSeenAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * The client has seen the plans modal.
 *
 * Written once. The modal opens on first login for a client without a plan and
 * never reopens by itself after that -- somebody who closed it has answered,
 * and reopening it every time they sign in is the behaviour that makes people
 * stop reading anything we put in front of them. The "Plan" item in the
 * navigation and the slim banner are how they find it again.
 */
router.post('/modal-seen', requireCSRF, async (req, res, next) => {
  try {
    if (req.user.role !== 'client') return res.json({ ok: true });

    if (!req.user.plansModalSeenAt) {
      await db.update('users', req.user.id, { plansModalSeenAt: new Date().toISOString() });
      await events.log('plans_modal_shown', { clientId: req.user.id });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
