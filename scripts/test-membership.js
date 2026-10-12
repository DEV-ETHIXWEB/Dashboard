'use strict';

/* The membership tables, checked against what the application is about to
   trust them for. Run from the repo root:

     npm run test:membership

   These are not "does the table exist" tests. Each one pins a guarantee a
   later step relies on: that money survives a round trip as a number, that two
   simultaneous requests cannot create two usage counters, that a client cannot
   end up on two plans at once, and that nothing on an account which predates
   this feature was quietly filled in.                                      */

const { db } = require('../db/setup');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n${name}`);
}

/** The deterministic id that makes a usage row race-safe. Mirrors utils/. */
function usageId(clientId, periodStart) {
  return `usage-${clientId}-${String(periodStart).slice(0, 10)}`;
}

async function main() {
  await require('../db/setup').seed();

  const client = (await db.filter('users', (u) => u.role === 'client'))[0];
  check('the test workspace has a client to hang a plan on', Boolean(client));
  if (!client) {
    console.log('\n0 passed, 1 failed');
    process.exit(1);
  }

  // --- subscriptions -------------------------------------------------------

  section('A subscription survives a round trip through the database');
  {
    const row = await db.insert('subscriptions', {
      clientId: client.id,
      planKey: 'unlimited',
      period: 12,
      amountUsd: 278.40,
      status: 'pending_payment',
      createdBy: 'test',
      createdAt: new Date().toISOString(),
    });

    eq('the plan key is kept', row.planKey, 'unlimited');
    eq('the period is a number, not a string', typeof row.period, 'number');
    eq('the period is right', row.period, 12);
    // NUMERIC comes back from `pg` as a string. A price that arrives as
    // '278.40' compares false against every number it is checked against and
    // concatenates when it should add, so this is the whole reason rowToCamel
    // coerces it.
    eq('the amount is a number, not a string', typeof row.amountUsd, 'number');
    eq('the amount kept its cents', row.amountUsd, 278.40);
    eq('a new subscription starts unpaid', row.status, 'pending_payment');
    eq('nothing was marked paid by itself', row.markedPaidAt, null);
    eq('the unlock moment has not happened', row.unlockSeenAt, null);
    eq('no confirmation has been sent', row.confirmationSentAt, null);
    eq('no renewal reminder has been sent', row.renewalReminderSentAt, null);
    eq('a first purchase carries no credit', row.creditUsd, null);
    eq('a first purchase supersedes nothing', row.previousSubscriptionId, null);

    const reread = await db.find('subscriptions', row.id);
    eq('and reads back the same amount on a plain find', reread.amountUsd, 278.40);
    eq('still as a number', typeof reread.amountUsd, 'number');
  }

  section('A cancellation date stays a date');
  {
    // `cancelled_at` is one column name answering to two kinds of column:
    // credential_deliveries stores an epoch-millisecond BIGINT, while
    // subscriptions and queued_requests store an ISO string. The driver used
    // to coerce it to a Number by name alone, which turned every ISO value
    // into NaN -- truthy at every `if (row.cancelledAt)` call site, and
    // printed as "NaN" on a billing page.
    const when = new Date().toISOString();

    const sub = await db.insert('subscriptions', {
      clientId: `${client.id}-cancel-probe`, planKey: 'basic', period: 1, amountUsd: 9,
      status: 'cancelled', cancelledAt: when, createdAt: when,
    });
    eq('a cancelled subscription keeps its date', sub.cancelledAt, when);
    eq('and it is still a string', typeof sub.cancelledAt, 'string');
    const reread = await db.find('subscriptions', sub.id);
    eq('on a plain read too', reread.cancelledAt, when);
    await db.remove('subscriptions', sub.id);

    const held = await db.insert('queued_requests', {
      clientId: client.id, subject: 'probe', category: 'Website',
      releaseAt: when, createdAt: when,
    });
    const cancelled = await db.update('queued_requests', held.id, { cancelledAt: when });
    eq('a cancelled held request keeps its date', cancelled.cancelledAt, when);
    eq('so a filter on it still works',
      (await db.filter('queued_requests', (q) => q.id === held.id && !q.cancelledAt)).length, 0);
    await db.remove('queued_requests', held.id);

    // And the BIGINT one is untouched: it still comes back as a number.
    const delivery = await db.insert('credential_deliveries', {
      userId: client.id, kind: 'password', status: 'cancelled',
      scheduledAt: Date.now(), cancelledAt: Date.now(), createdAt: when,
    });
    eq('while a credential delivery still gets a number',
      typeof (await db.find('credential_deliveries', delivery.id)).cancelledAt, 'number');
    await db.remove('credential_deliveries', delivery.id);
  }

  section('A credit on an upgrade is money too');
  {
    const row = await db.insert('subscriptions', {
      clientId: `${client.id}-upgrade-probe`,
      planKey: 'unlimited',
      period: 6,
      amountUsd: 99.45,
      creditUsd: 48.45,
      previousSubscriptionId: 'sub-old',
      status: 'pending_payment',
      createdAt: new Date().toISOString(),
    });
    eq('the credit is a number', typeof row.creditUsd, 'number');
    eq('the credit kept its cents', row.creditUsd, 48.45);
    eq('the superseded subscription is recorded', row.previousSubscriptionId, 'sub-old');
    await db.remove('subscriptions', row.id);
  }

  section('A client cannot be on two plans at once');
  {
    const probe = `${client.id}-two-plans`;
    const first = await db.insert('subscriptions', {
      clientId: probe, planKey: 'basic', period: 1, amountUsd: 9,
      status: 'active', startedAt: new Date().toISOString(),
    });

    /* The guard that holds on BOTH drivers is utils/subscriptions.js: it
       retires the plan being replaced inside the same operation that starts
       the new one. That is what is checked here, by driving a real upgrade
       rather than by poking two rows into the table.

       The Postgres deployment also carries a partial unique index as a
       backstop, which is not installed under pg-mem -- the engine answers
       ordinary `WHERE client_id = ?` queries out of it and silently drops
       every non-active row. See db/setup.js and scripts/dev-with-pgmem.js. */
    const subs = require('../utils/subscriptions');
    const second = await db.insert('subscriptions', {
      clientId: probe, planKey: 'unlimited', period: 1, amountUsd: 29,
      status: 'pending_payment', createdAt: new Date().toISOString(),
    });
    await subs.activate(second.id, { byUserId: 'test' });

    const actives = (await db.where('subscriptions', { clientId: probe }))
      .filter((s) => s.status === 'active');
    eq('starting a second plan leaves exactly one active', actives.length, 1);
    eq('and it is the one just started', actives[0].id, second.id);
    eq('the plan it replaced is expired, not left running',
      (await db.find('subscriptions', first.id)).status, 'expired');

    await db.remove('subscriptions', second.id);

    // A superseded plan sitting beside an active one is the normal state after
    // an upgrade, so the index must not stand in the way of the history.
    let historyOk = true;
    try {
      const old = await db.insert('subscriptions', {
        clientId: probe, planKey: 'managed', period: 1, amountUsd: 19,
        status: 'cancelled', cancelledAt: new Date().toISOString(),
      });
      await db.remove('subscriptions', old.id);
    } catch {
      historyOk = false;
    }
    check('but a cancelled plan may sit beside the active one', historyOk);

    await db.remove('subscriptions', first.id);
  }

  // --- update request usage ------------------------------------------------

  section('Two requests in the same second cannot create two counters');
  {
    const periodStart = '2026-10-01T00:00:00.000Z';
    const id = usageId(client.id, periodStart);

    const first = await db.insert('update_request_usage', {
      id,
      clientId: client.id,
      periodStart,
      periodEnd: '2026-11-01T00:00:00.000Z',
      count: 0,
      extraCount: 0,
      updatedAt: new Date().toISOString(),
    });
    eq('the counter starts at zero', first.count, 0);
    eq('and counts no extras yet', first.extraCount, 0);
    eq('the count is a number', typeof first.count, 'number');

    let refused = false;
    try {
      await db.insert('update_request_usage', {
        id, clientId: client.id, periodStart, count: 0, extraCount: 0,
      });
    } catch {
      refused = true;
    }
    // This refusal is the whole design. The id is derived from the client and
    // the month rather than random, so the database itself rejects the second
    // insert and the caller reads the existing row instead of racing it.
    check('a second counter for the same client and month is refused', refused);

    // --- counting ---------------------------------------------------------
    // incrementIfBelow is one atomic statement on Postgres and a transaction
    // on Firestore. A read-then-write here would let two requests both see
    // "1 of 2 used" and both go through, which is the bug this avoids.
    const one = await db.incrementIfBelow('update_request_usage', id, 'count', 2);
    eq('the first request consumes one of two', one.count, 1);
    const two = await db.incrementIfBelow('update_request_usage', id, 'count', 2);
    eq('the second consumes the other', two.count, 2);
    const three = await db.incrementIfBelow('update_request_usage', id, 'count', 2);
    eq('the third is refused rather than counted', three, null);

    const after = await db.find('update_request_usage', id);
    eq('and the counter was not nudged past the allowance', after.count, 2);

    // Extras have no ceiling: past the allowance the work still gets done, it
    // is just quoted and charged. A huge max is how "increment, no cap" is
    // expressed with the one atomic primitive both drivers have.
    const extra = await db.incrementIfBelow('update_request_usage', id, 'extraCount', Number.MAX_SAFE_INTEGER);
    eq('a chargeable extra is counted separately', extra.extraCount, 1);
    eq('and does not touch the included allowance', extra.count, 2);

    await db.remove('update_request_usage', id);
  }

  // --- queued requests -----------------------------------------------------

  section('A saved request is held, not turned into a ticket');
  {
    const row = await db.insert('queued_requests', {
      clientId: client.id,
      subject: 'Add a winter promotion banner',
      category: 'Website',
      description: 'Same as last year, with the new phone number.',
      priority: 'Normal',
      releaseAt: '2026-11-01T00:00:00.000Z',
      createdAt: new Date().toISOString(),
    });

    eq('the text the client typed is kept verbatim',
      row.description, 'Same as last year, with the new phone number.');
    eq('it knows when it is due to be released', row.releaseAt, '2026-11-01T00:00:00.000Z');
    eq('it has not been released', row.releasedAt, null);
    eq('and is not a ticket yet', row.ticketId, null);

    // The point of a separate table: it must not appear in the ticket queue,
    // because a ticket starts an SLA clock nobody agreed to.
    const tickets = await db.filter('tickets', (t) => t.subject === 'Add a winter promotion banner');
    eq('nothing was added to the ticket queue', tickets.length, 0);

    await db.remove('queued_requests', row.id);
  }

  // --- membership events ---------------------------------------------------

  section('An event keeps its detail through the database');
  {
    const row = await db.insert('membership_events', {
      clientId: client.id,
      type: 'upsell_shown',
      // Stored as JSON text on Postgres and as an object on Firestore. The
      // driver is what hides that difference; a caller reads an object either
      // way or this assertion fails.
      metadata: { trigger: 'locked_feature', panel: 'backups', recommended: 'unlimited' },
      actorId: 'system',
      createdAt: new Date().toISOString(),
    });

    eq('the type is kept', row.type, 'upsell_shown');
    const reread = await db.find('membership_events', row.id);
    eq('the detail comes back as an object, not a string', typeof reread.metadata, 'object');
    eq('and every field survived', reread.metadata.trigger, 'locked_feature');
    eq('including the one the funnel is measured on', reread.metadata.recommended, 'unlimited');

    await db.remove('membership_events', row.id);
  }

  section('An event with no detail is still a usable event');
  {
    // Most events carry nothing beyond their type -- "they closed the modal",
    // "payment was confirmed" -- and the funnel is counted on `type`, so a
    // null blob has to be ordinary rather than a special case.
    const row = await db.insert('membership_events', {
      clientId: client.id, type: 'plans_modal_shown', createdAt: new Date().toISOString(),
    });
    const reread = await db.find('membership_events', row.id);
    eq('the type is all it needs', reread.type, 'plans_modal_shown');
    eq('and the missing detail reads as nothing, not as a crash', reread.metadata ?? null, null);
    await db.remove('membership_events', row.id);
  }

  // --- what was NOT done to existing accounts ------------------------------

  section('Accounts that predate membership were left alone');
  {
    const fresh = await db.find('users', client.id);
    eq('no welcome email is recorded as sent', fresh.welcomeEmailSentAt ?? null, null);
    eq('the plans modal has not been seen', fresh.plansModalSeenAt ?? null, null);
    eq('there is no first login on record', fresh.firstLoginAt ?? null, null);
    eq('nobody is snoozed', fresh.upsellSnoozedUntil ?? null, null);
    eq('no upsell has been shown', fresh.upsellLastShownAt ?? null, null);
    // A backfilled timestamp here would mean this client never gets the
    // welcome email and never sees the modal, which is the one outcome the
    // migration had to avoid.
    eq('the dismissal streak starts at zero', Number(fresh.upsellDismissStreak ?? 0), 0);
  }

  section('The membership columns are writable under their canonical names');
  {
    const now = new Date().toISOString();
    const updated = await db.update('users', client.id, {
      welcomeEmailSentAt: now,
      firstLoginAt: now,
      plansModalSeenAt: now,
      upsellDismissStreak: 2,
      upsellLastMessage: 'managed-2-changes',
    });
    eq('the welcome stamp sticks', updated.welcomeEmailSentAt, now);
    eq('the modal stamp sticks', updated.plansModalSeenAt, now);
    eq('the streak is a number', typeof updated.upsellDismissStreak, 'number');
    eq('the streak sticks', updated.upsellDismissStreak, 2);
    eq('the last message shown sticks', updated.upsellLastMessage, 'managed-2-changes');

    // Same rule the rest of the app lives by: snake_case is not a synonym a
    // guard can be walked around with. See isWritableField in db/schemas.js.
    const sneaky = await db.update('users', client.id, { welcome_email_sent_at: '1999-01-01T00:00:00.000Z' });
    eq('a snake_case spelling is dropped, not accepted', sneaky.welcomeEmailSentAt, now);

    // Put it back, so a later run of the suite starts where this one did.
    await db.update('users', client.id, {
      welcomeEmailSentAt: null, firstLoginAt: null, plansModalSeenAt: null,
      upsellDismissStreak: 0, upsellLastMessage: null,
    });
  }

  // --- a downgrade is scheduled, not applied today -------------------------

  /* The client is told "your current plan runs until <date>, and the cheaper
     one starts after that. There is nothing to pay now", and the quote says
     scheduled with nothing due. These pin the write path to that promise.

     The bug these exist to stop: a downgrade recorded as `pending_payment`
     like any other choice, which puts it on the admin's list of money to
     collect and lets mark-paid start it the same day -- billing a client who
     was told they owed nothing, and throwing away the months of the dearer
     plan they had already paid for.                                        */

  section('A downgrade does not start today, and nobody can make it');
  {
    const subs = require('../utils/subscriptions');
    const plans = require('../lib/plans');

    const mover = await db.insert('users', {
      name: 'Downgrade Probe', email: `down-${Date.now()}@probe.test`,
      role: 'client', password: 'x',
    });

    // One month into six months of Unlimited, paid in full.
    const startedAt = new Date(Date.now() - 30 * 864e5);
    const paid = await db.insert('subscriptions', {
      clientId: mover.id, planKey: 'unlimited', period: 6,
      amountUsd: plans.amountFor('unlimited', 6), status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plans.renewalDate(startedAt, 6).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    const quote = await subs.quoteFor(mover.id, 'basic', 1);
    eq('the quote calls it a downgrade', quote.kind, 'downgrade');
    eq('it is scheduled rather than bought', quote.scheduled, true);
    eq('nothing is due today', quote.dueNowUsd, 0);
    eq('it begins when the paid period ends', quote.startsAt, paid.renewsAt);

    // Exactly what routes/membership.js POST /select writes.
    const chosen = await db.insert('subscriptions', {
      clientId: mover.id, planKey: 'basic', period: 1,
      amountUsd: quote.amountUsd,
      previousSubscriptionId: quote.from.subscriptionId,
      status: quote.scheduled ? 'scheduled' : 'pending_payment',
      startsAt: quote.scheduled ? quote.startsAt : null,
      createdAt: new Date().toISOString(),
    });
    eq('the row is scheduled, not awaiting payment', chosen.status, 'scheduled');
    eq('and it carries the day it may begin', chosen.startsAt, paid.renewsAt);

    // The admin's queue is `pending_payment` only, so a scheduled row must not
    // be on it -- there is nothing to collect yet.
    const queue = await db.filter('subscriptions', (s) => s.status === 'pending_payment');
    check('it is not on the list of payments to collect',
      !queue.some((s) => s.id === chosen.id));

    let refused = null;
    try { await subs.activate(chosen.id, { byUserId: 'admin' }); } catch (err) { refused = err.message; }
    check('EXPLOIT BLOCKED: it cannot be activated early', Boolean(refused), 'it activated');
    check('and the refusal says why', /scheduled/.test(refused || ''), refused);

    const state = await subs.stateFor(mover);
    eq('the client is still on the plan they paid for', state.planKey, 'unlimited');
    eq('with every perk of it', state.entitlements.length, plans.entitlementsFor('unlimited').length);
    eq('the scheduled change is reported on its own', state.scheduledSubscription.planKey, 'basic');
    eq('and is not reported as a payment we are waiting on', state.awaitingPayment, false);

    section('When the paid period runs out, the downgrade becomes payable');
    const afterwards = new Date(new Date(paid.renewsAt).getTime() + 864e5);
    eq('the sweep promotes it', await subs.promoteScheduled(afterwards), 1);
    const promoted = await db.find('subscriptions', chosen.id);
    eq('it is awaiting payment now', promoted.status, 'pending_payment');
    eq('for the Basic list price', Number(promoted.amountUsd), 9);
    eq('and promoting again does nothing', await subs.promoteScheduled(afterwards), 0);

    section('A downgrade somebody changed their mind about is dropped, not billed');
    const switcher = await db.insert('users', {
      name: 'Switcher Probe', email: `switch-${Date.now()}@probe.test`,
      role: 'client', password: 'x',
    });
    const dear = await db.insert('subscriptions', {
      clientId: switcher.id, planKey: 'managed', period: 6, amountUsd: 96.9,
      status: 'active', startedAt: startedAt.toISOString(),
      renewsAt: plans.renewalDate(startedAt, 6).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });
    const stale = await db.insert('subscriptions', {
      clientId: switcher.id, planKey: 'basic', period: 1, amountUsd: 9,
      status: 'scheduled', startsAt: dear.renewsAt, previousSubscriptionId: dear.id,
      createdAt: new Date().toISOString(),
    });
    // They go up to Unlimited instead, which supersedes the Managed row.
    await db.update('subscriptions', dear.id, { status: 'expired' });
    await db.insert('subscriptions', {
      clientId: switcher.id, planKey: 'unlimited', period: 12, amountUsd: 278.4,
      status: 'active', startedAt: new Date().toISOString(),
      renewsAt: plans.renewalDate(new Date(), 12).toISOString(),
      markedPaidAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    });
    await subs.promoteScheduled(new Date(new Date(dear.renewsAt).getTime() + 864e5));
    eq('a client who upgraded instead is not put on Basic months later',
      (await db.find('subscriptions', stale.id)).status, 'expired');

    section('A client who leaves does not start a plan weeks afterwards');
    const leaver = await db.insert('users', {
      name: 'Leaver Probe', email: `leave-${Date.now()}@probe.test`,
      role: 'client', password: 'x',
    });
    const running = await db.insert('subscriptions', {
      clientId: leaver.id, planKey: 'managed', period: 6, amountUsd: 96.9,
      status: 'active', startedAt: startedAt.toISOString(),
      renewsAt: plans.renewalDate(startedAt, 6).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });
    const alsoScheduled = await db.insert('subscriptions', {
      clientId: leaver.id, planKey: 'basic', period: 1, amountUsd: 9,
      status: 'scheduled', startsAt: running.renewsAt,
      previousSubscriptionId: running.id, createdAt: new Date().toISOString(),
    });
    await subs.cancel(running.id, { byUserId: 'admin', reason: 'done' });
    eq('a cancellation takes the scheduled change with it',
      (await db.find('subscriptions', alsoScheduled.id)).status, 'expired');
  }

  // --- the allowance belongs to whoever the plan governs --------------------

  /* `check` measures the allowance against the subscription that *governs*,
     which is active, past_due, or a cancellation still inside its period. The
     consuming step has to read the same one.

     The bug these exist to stop: `consume` reading only the `active` row, so a
     client whose card failed -- or who cancelled and is still inside the period
     they paid for -- had two updates showing on their billing page and no
     window to spend them in. The route reads a false return as "that used the
     last of your updates", so they were refused outright with the full
     allowance on screen.                                                    */

  section('The two updates a client paid for survive a failed card');
  {
    const subs = require('../utils/subscriptions');
    const updates = require('../utils/updateRequests');
    const plans = require('../lib/plans');

    for (const [label, status] of [['active', 'active'], ['past_due', 'past_due'], ['cancelled', 'cancelled']]) {
      const who = await db.insert('users', {
        name: `Allowance ${label}`, email: `allow-${status}-${Date.now()}@probe.test`,
        role: 'client', password: 'x',
      });
      const startedAt = new Date(Date.now() - 10 * 864e5);
      await db.insert('subscriptions', {
        clientId: who.id, planKey: 'managed', period: 1, amountUsd: 19, status,
        startedAt: startedAt.toISOString(),
        renewsAt: plans.renewalDate(startedAt, 1).toISOString(),
        markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
        ...(status === 'cancelled' ? { cancelledAt: new Date().toISOString() } : {}),
      });

      const state = await subs.stateFor(who);
      eq(`${label}: the plan still governs`, state.planKey, 'managed');
      eq(`${label}: two updates are showing`, state.usage.remaining, 2);

      const gate = await updates.check(who, { category: 'Website' });
      eq(`${label}: the request is allowed`, gate.ok, true);
      eq(`${label}: and it counts against the allowance`, gate.counts, true);

      // The line that was wrong: a window must exist to spend it in.
      eq(`${label}: the update is actually consumable`, await updates.consume(who.id, gate.state), true);
      eq(`${label}: and one is now spent`, (await subs.stateFor(who)).usage.used, 1);
    }
  }

  // --- two of the same request, at the same moment -------------------------

  /* `read the status, decide, then write` is not a decision when two requests
     run it together. Both see `pending_payment`, both decide there is a
     payment to confirm, and both do the work -- one payment, two of
     everything. These pin the compare-and-set that stops it.

     It is not hypothetical: two admins are told the money landed, or a
     request is retried, and the sweeps ride on ordinary API traffic so two
     requests arriving together both run them. */

  section('One payment confirmed by five callers at once is confirmed once');
  {
    const subs = require('../utils/subscriptions');
    const plansLib = require('../lib/plans');
    const events = require('../utils/membershipEvents');

    const payer = await db.insert('users', {
      name: 'Race Payer', email: `race-pay-${Date.now()}@probe.test`,
      role: 'client', password: 'x',
    });
    const sub = await db.insert('subscriptions', {
      clientId: payer.id, planKey: 'unlimited', period: 12,
      amountUsd: plansLib.amountFor('unlimited', 12), status: 'pending_payment',
      createdAt: new Date().toISOString(),
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => subs.activate(sub.id, { byUserId: 'admin' })),
    );
    const done = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    eq('exactly one caller starts the plan', done.filter((d) => d && !d.alreadyActive).length, 1);
    eq('the rest are told it is already running', done.filter((d) => d && d.alreadyActive).length, 4);
    eq('the client is on exactly one active plan',
      (await db.where('subscriptions', { clientId: payer.id })).filter((s) => s.status === 'active').length, 1);
    eq('and the payment is on the record once, not five times',
      (await events.forClient(payer.id, { types: ['payment_confirmed'] })).length, 1);
  }

  section('Ten update requests in the same second spend exactly the two allowed');
  {
    const subs = require('../utils/subscriptions');
    const updates = require('../utils/updateRequests');
    const plansLib = require('../lib/plans');

    const racer = await db.insert('users', {
      name: 'Race Client', email: `race-use-${Date.now()}@probe.test`,
      role: 'client', password: 'x',
    });
    const startedAt = new Date(Date.now() - 3 * 864e5);
    await db.insert('subscriptions', {
      clientId: racer.id, planKey: 'managed', period: 1, amountUsd: 19, status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 1).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    const state = await subs.stateFor(racer);
    const granted = (await Promise.all(
      Array.from({ length: 10 }, () => updates.consume(racer.id, state)),
    )).filter(Boolean);
    eq('exactly two get through', granted.length, 2);
    eq('the meter reads two, never more', (await subs.stateFor(racer)).usage.used, 2);
    eq('and the ten of them share one counter row',
      (await db.where('update_request_usage', { clientId: racer.id })).length, 1);
  }

  section('Two sweeps running together promote a scheduled change once');
  {
    const subs = require('../utils/subscriptions');
    const plansLib = require('../lib/plans');

    const mover = await db.insert('users', {
      name: 'Race Sched', email: `race-sch-${Date.now()}@probe.test`,
      role: 'client', password: 'x',
    });
    const startedAt = new Date(Date.now() - 40 * 864e5);
    const running = await db.insert('subscriptions', {
      clientId: mover.id, planKey: 'managed', period: 1, amountUsd: 19, status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 1).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });
    const scheduled = await db.insert('subscriptions', {
      clientId: mover.id, planKey: 'basic', period: 1, amountUsd: 9, status: 'scheduled',
      startsAt: running.renewsAt, previousSubscriptionId: running.id,
      createdAt: new Date().toISOString(),
    });

    const afterwards = new Date(new Date(running.renewsAt).getTime() + 864e5);
    const [a, b] = await Promise.all([
      subs.promoteScheduled(afterwards), subs.promoteScheduled(afterwards),
    ]);
    eq('promoted once in total, not once per sweep', a + b, 1);
    eq('and it is awaiting payment',
      (await db.find('subscriptions', scheduled.id)).status, 'pending_payment');
  }

  /* ------------------------------------------------------------------ QA --
     Everything below was found by testing the money flows against the real
     code rather than against the tests. Each block names the behaviour it
     pins, because every one of them was a way for a client to be charged
     wrongly, kept for nothing, or billed twice.                            */

  /** A client with nothing on their account, for a test that needs a clean one. */
  async function freshClient(label) {
    return db.insert('users', {
      name: label,
      email: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@probe.test`,
      role: 'client',
      password: 'x',
    });
  }

  section('A paid period ends, and asks to be renewed');
  {
    /* The largest gap in the feature: nothing read `renews_at`. A plan went
       active, the renewal date came and went, and the row stayed `active` for
       ever -- so one payment bought the product permanently and no second
       period was ever collected.                                           */
    const subs = require('../utils/subscriptions');
    const plansLib = require('../lib/plans');

    const who = await freshClient('Renews');
    const startedAt = new Date(Date.now() - 40 * 864e5);
    const running = await db.insert('subscriptions', {
      clientId: who.id, planKey: 'managed', period: 1, amountUsd: 19, status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 1).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    const dayAfter = new Date(new Date(running.renewsAt).getTime() + 864e5);
    // Counted per row rather than per sweep: this suite leaves other
    // subscriptions behind and the sweep is workspace-wide.
    check('the sweep picks it up', (await subs.renewDue(dayAfter)) >= 1);

    const ended = await db.find('subscriptions', running.id);
    eq('the finished period is past due', ended.status, 'past_due');
    eq('and records the day it ran out', ended.pastDueSince, running.renewsAt);

    const history = await subs.historyFor(who.id);
    const renewal = history.find((row) => row.status === 'pending_payment');
    check('a renewal is waiting on payment', Boolean(renewal));
    eq('for the same plan', renewal.planKey, 'managed');
    eq('for the same period', renewal.period, 1);
    eq('at the list price, uncredited', renewal.amountUsd, plansLib.amountFor('managed', 1));
    eq('and it knows which period it follows', renewal.previousSubscriptionId, running.id);

    // The perks keep running while we collect, which is the whole reason
    // `past_due` grants at all under a manual payment flow.
    const during = await subs.stateFor(who, dayAfter);
    eq('the plan still governs inside the grace window', during.effectivePlanKey, 'managed');
    check('and the client is told when that ends', Boolean(during.graceEndsAt));

    // And then they stop, which is the half that makes the first half honest.
    const afterGrace = new Date(
      new Date(running.renewsAt).getTime() + (subs.PAST_DUE_GRACE_DAYS + 1) * 864e5,
    );
    const after = await subs.stateFor(who, afterGrace);
    eq('past the grace window it grants nothing', after.effectivePlanKey, null);

    check('the lapse is swept up', (await subs.expireLapsed(afterGrace)) >= 1);
    eq('the row is expired, not cancelled -- nobody asked to leave',
      (await db.find('subscriptions', running.id)).status, 'expired');
    eq('and a second sweep has nothing left to do', await subs.expireLapsed(afterGrace), 0);

    // Two sweeps at once must open one renewal, not two bills.
    const other = await freshClient('Renews Race');
    const raceStart = new Date(Date.now() - 40 * 864e5);
    const raceRow = await db.insert('subscriptions', {
      clientId: other.id, planKey: 'basic', period: 1, amountUsd: 9, status: 'active',
      startedAt: raceStart.toISOString(),
      renewsAt: plansLib.renewalDate(raceStart, 1).toISOString(),
      markedPaidAt: raceStart.toISOString(), createdAt: raceStart.toISOString(),
    });
    const raceAt = new Date(new Date(raceRow.renewsAt).getTime() + 864e5);
    const [x, y] = await Promise.all([subs.renewDue(raceAt), subs.renewDue(raceAt)]);
    eq('two sweeps together renew once, not twice', x + y, 1);
    eq('so there is exactly one renewal to collect',
      (await subs.historyFor(other.id)).filter((r) => r.status === 'pending_payment').length, 1);
  }

  section('An upgrade is priced when the money lands, not when it was chosen');
  {
    /* The credit on an upgrade is the unused part of the plan being replaced,
       and it shrinks every day. Frozen at the moment of choosing, a plan
       picked on day 1 and paid for on day 300 still credited the whole of a
       twelve-month Managed plan -- about $181.90 against $31.98 of real
       remaining value, so we handed over $150 of Unlimited for nothing.    */
    const subs = require('../utils/subscriptions');
    const plansLib = require('../lib/plans');

    const who = await freshClient('Reprice');
    const startedAt = new Date(Date.UTC(2026, 0, 1));
    const managed = await db.insert('subscriptions', {
      clientId: who.id, planKey: 'managed', period: 12,
      amountUsd: plansLib.amountFor('managed', 12), status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 12).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    // Chosen on day one, when almost the whole year is unused.
    const dayOne = new Date(startedAt.getTime() + 864e5);
    const quotedThen = await subs.quoteFor(who.id, 'unlimited', 12, dayOne);
    check('the credit on day one is nearly the whole year',
      quotedThen.creditUsd > 170, String(quotedThen.creditUsd));

    const chosen = await db.insert('subscriptions', {
      clientId: who.id, planKey: 'unlimited', period: 12,
      amountUsd: quotedThen.amountUsd, creditUsd: quotedThen.creditUsd,
      previousSubscriptionId: managed.id, status: 'pending_payment',
      createdAt: dayOne.toISOString(),
    });

    // Paid for 300 days later, by which time there is almost nothing left.
    const muchLater = new Date(startedAt.getTime() + 300 * 864e5);
    const repriced = await subs.repriceFor(chosen, muchLater);
    check('by day 300 the credit is a fraction of that',
      repriced.creditUsd < 40, String(repriced.creditUsd));
    check('and the amount owed has gone up to match',
      repriced.amountUsd > quotedThen.amountUsd, `${repriced.amountUsd} vs ${quotedThen.amountUsd}`);
    check('which is flagged as a change from the quote', repriced.changed === true);

    const result = await subs.activate(chosen.id, { byUserId: 'test', now: muchLater });
    eq('the row records what was actually owed', result.subscription.amountUsd, repriced.amountUsd);
    eq('and the credit that was actually given', result.subscription.creditUsd, repriced.creditUsd);
    eq('the plan it replaced is retired', (await db.find('subscriptions', managed.id)).status, 'expired');
  }

  section('A credit bigger than the bill buys time instead of vanishing');
  {
    /* Twelve months of Managed moved onto one month of Unlimited: the bill is
       $29 and the credit is about $182. Clamping the credit to the price made
       the month free and silently burned the other ~$152 of time the client
       had already paid for.                                                */
    const subs = require('../utils/subscriptions');
    const plansLib = require('../lib/plans');

    const who = await freshClient('Carry');
    const startedAt = new Date(Date.UTC(2026, 0, 1));
    const managed = await db.insert('subscriptions', {
      clientId: who.id, planKey: 'managed', period: 12,
      amountUsd: plansLib.amountFor('managed', 12), status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 12).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    const at = new Date(startedAt.getTime() + 864e5);
    const quote = await subs.quoteFor(who.id, 'unlimited', 1, at);
    eq('the month itself costs nothing', quote.amountUsd, 0);
    check('but the leftover is reported, not dropped',
      quote.creditCarriedUsd > 140, String(quote.creditCarriedUsd));
    check('and it is expressed as real days', quote.bonusDays > 140, String(quote.bonusDays));

    const chosen = await db.insert('subscriptions', {
      clientId: who.id, planKey: 'unlimited', period: 1,
      amountUsd: quote.amountUsd, creditUsd: quote.creditUsd,
      previousSubscriptionId: managed.id, status: 'pending_payment',
      createdAt: at.toISOString(),
    });

    const result = await subs.activate(chosen.id, { byUserId: 'test', now: at });
    check('the carried credit is written down', Number(result.subscription.creditCarriedUsd) > 140,
      String(result.subscription.creditCarriedUsd));
    const renews = new Date(result.subscription.renewsAt);
    const plainMonth = plansLib.renewalDate(at, 1);
    check('and the period runs well past a bare month',
      renews.getTime() > plainMonth.getTime() + 140 * 864e5,
      `${result.subscription.renewsAt} vs ${plainMonth.toISOString()}`);
  }

  section('A period continues from the old one rather than restarting');
  {
    /* Two clients lost days to this. One renewed five days early and had those
       five days started over. One cancelled, changed their mind inside the
       period they had already paid for, and lost the whole remainder -- 61
       days in the report that found it.                                     */
    const subs = require('../utils/subscriptions');
    const plansLib = require('../lib/plans');

    // --- renewing early ---------------------------------------------------
    const early = await freshClient('Early');
    const startedAt = new Date(Date.UTC(2026, 0, 1));
    const oldRenews = plansLib.renewalDate(startedAt, 1);
    await db.insert('subscriptions', {
      clientId: early.id, planKey: 'managed', period: 1, amountUsd: 19, status: 'active',
      startedAt: startedAt.toISOString(), renewsAt: oldRenews.toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    const fiveDaysEarly = new Date(oldRenews.getTime() - 5 * 864e5);
    const renewal = await db.insert('subscriptions', {
      clientId: early.id, planKey: 'managed', period: 1, amountUsd: 19,
      status: 'pending_payment', createdAt: fiveDaysEarly.toISOString(),
    });
    const paid = await subs.activate(renewal.id, { byUserId: 'test', now: fiveDaysEarly });
    eq('an early renewal starts when the old period ends, not today',
      paid.subscription.renewsAt, plansLib.renewalDate(oldRenews, 1).toISOString());

    // --- re-subscribing after cancelling ----------------------------------
    const back = await freshClient('Returning');
    const backStart = new Date(Date.UTC(2026, 0, 1));
    const backRenews = plansLib.renewalDate(backStart, 6);
    await db.insert('subscriptions', {
      clientId: back.id, planKey: 'managed', period: 6,
      amountUsd: plansLib.amountFor('managed', 6), status: 'cancelled',
      startedAt: backStart.toISOString(), renewsAt: backRenews.toISOString(),
      cancelledAt: new Date(backStart.getTime() + 864e5).toISOString(),
      markedPaidAt: backStart.toISOString(), createdAt: backStart.toISOString(),
    });

    const twoMonthsIn = new Date(backStart.getTime() + 61 * 864e5);
    const again = await db.insert('subscriptions', {
      clientId: back.id, planKey: 'managed', period: 6,
      amountUsd: plansLib.amountFor('managed', 6),
      status: 'pending_payment', createdAt: twoMonthsIn.toISOString(),
    });
    const resumed = await subs.activate(again.id, { byUserId: 'test', now: twoMonthsIn });
    eq('re-subscribing keeps the days already paid for',
      resumed.subscription.renewsAt, plansLib.renewalDate(backRenews, 6).toISOString());

    // --- but an upgrade credits those days instead of extending -----------
    // Credit or time, never both: an upgrade hands the unused days back as
    // money, so extending the period as well would pay for them twice.
    const up = await freshClient('Upgrading');
    const upStart = new Date(Date.UTC(2026, 0, 1));
    const upRenews = plansLib.renewalDate(upStart, 6);
    const upOld = await db.insert('subscriptions', {
      clientId: up.id, planKey: 'managed', period: 6,
      amountUsd: plansLib.amountFor('managed', 6), status: 'active',
      startedAt: upStart.toISOString(), renewsAt: upRenews.toISOString(),
      markedPaidAt: upStart.toISOString(), createdAt: upStart.toISOString(),
    });
    const upAt = new Date(upStart.getTime() + 30 * 864e5);
    const upQuote = await subs.quoteFor(up.id, 'unlimited', 6, upAt);
    check('the upgrade is credited', upQuote.creditUsd > 0, String(upQuote.creditUsd));
    eq('so the new period starts today', upQuote.periodStartsAt, upAt.toISOString());
    eq('and nothing is said about continuing', upQuote.continuesFrom, null);
    eq('the old row is the one being replaced', upQuote.from.subscriptionId, upOld.id);
  }

  section('A held request becomes one ticket, however many sweeps run');
  {
    /* Reproduced in the QA report: one held request, two Vercel instances
       running the release sweep, two tickets, and two of the client's two
       updates spent. Writing `released_at` after creating the ticket was a
       read followed by a write, which is not a decision when two callers make
       it at once.                                                           */
    const updates = require('../utils/updateRequests');
    const plansLib = require('../lib/plans');

    const who = await freshClient('Holder');
    const startedAt = new Date(Date.now() - 2 * 864e5);
    await db.insert('subscriptions', {
      clientId: who.id, planKey: 'managed', period: 1, amountUsd: 19, status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 1).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    const held = await db.insert('queued_requests', {
      clientId: who.id, subject: 'Swap the hero image', category: 'Website',
      description: 'The new one is attached.', priority: 'Normal',
      releaseAt: new Date(Date.now() - 864e5).toISOString(),
      createdAt: new Date(Date.now() - 5 * 864e5).toISOString(),
    });

    const before = (await db.all('tickets')).length;
    const [a, b] = await Promise.all([updates.releaseDue(), updates.releaseDue()]);
    eq('released once in total, not once per sweep', a + b, 1);
    eq('so exactly one ticket was raised', (await db.all('tickets')).length - before, 1);

    const row = await db.find('queued_requests', held.id);
    check('the held request is marked released', Boolean(row.releasedAt));
    check('and points at the ticket it became', Boolean(row.ticketId));

    const usage = await db.find(
      'update_request_usage',
      usageId(who.id, require('../utils/subscriptions').usageWindow(
        await require('../utils/subscriptions').governingFor(who.id),
      ).periodStart),
    );
    eq('and it spent one update, not two', Number(usage.count), 1);
  }

  section('A held request nobody has room for is moved on, not stuck');
  {
    /* It sat permanently due instead: retried every minute for ever, with
       neither the client nor the team ever told it had not landed.          */
    const updates = require('../utils/updateRequests');
    const plansLib = require('../lib/plans');
    const subs = require('../utils/subscriptions');

    const who = await freshClient('Crowded');
    const startedAt = new Date(Date.now() - 2 * 864e5);
    await db.insert('subscriptions', {
      clientId: who.id, planKey: 'managed', period: 1, amountUsd: 19, status: 'active',
      startedAt: startedAt.toISOString(),
      renewsAt: plansLib.renewalDate(startedAt, 1).toISOString(),
      markedPaidAt: startedAt.toISOString(), createdAt: startedAt.toISOString(),
    });

    // Spend the whole allowance first, which is exactly how a client gets
    // here: they held one request and then raised two others.
    const state = await subs.stateFor(who);
    await updates.consume(who.id, state);
    await updates.consume(who.id, state);

    const held = await db.insert('queued_requests', {
      clientId: who.id, subject: 'Add the new team page', category: 'Website',
      description: '', priority: 'Normal',
      releaseAt: new Date(Date.now() - 864e5).toISOString(),
      createdAt: new Date(Date.now() - 5 * 864e5).toISOString(),
    });

    const before = (await db.all('tickets')).length;
    eq('nothing is released', await updates.releaseDue(), 0);
    eq('and no ticket was raised', (await db.all('tickets')).length - before, 0);

    const row = await db.find('queued_requests', held.id);
    eq('the request is still being held', row.releasedAt, null);
    eq('it has been counted as deferred once', Number(row.deferredCount), 1);
    check('its release date has moved into the future',
      new Date(row.releaseAt).getTime() > Date.now(), row.releaseAt);

    const told = await db.filter('notifications', (n) => n.userId === who.id);
    check('and the client was told rather than left wondering', told.length > 0);
  }

  section('A chosen plan nobody paid for does not wait for ever');
  {
    const subs = require('../utils/subscriptions');

    const who = await freshClient('Forgot');
    const longAgo = new Date(Date.now() - (subs.PENDING_CHOICE_DAYS + 3) * 864e5);
    const stale = await db.insert('subscriptions', {
      clientId: who.id, planKey: 'unlimited', period: 1, amountUsd: 29,
      status: 'pending_payment', createdAt: longAgo.toISOString(),
    });
    const fresh = await db.insert('subscriptions', {
      clientId: (await freshClient('Just Chose')).id, planKey: 'unlimited', period: 1,
      amountUsd: 29, status: 'pending_payment', createdAt: new Date().toISOString(),
    });

    eq('the stale one is dropped', await subs.expireStalePending(), 1);
    eq('and recorded as expired', (await db.find('subscriptions', stale.id)).status, 'expired');
    eq("today's choice is left alone",
      (await db.find('subscriptions', fresh.id)).status, 'pending_payment');
    check('the client was told, with the offer to choose again',
      (await db.filter('notifications', (n) => n.userId === who.id)).length > 0);
  }

  section('An allowance anchored to the 31st resets on a day that exists');
  {
    /* A plan started on January 31st put the whole of March 1st and 2nd into a
       window beginning March 3rd -- so the window did not contain the day it
       was being asked about, the allowance reset twice, and neither reset was
       on the client's billing day.                                          */
    const subs = require('../utils/subscriptions');

    const subscription = {
      startedAt: new Date(Date.UTC(2026, 0, 31, 9, 0, 0)).toISOString(),
      status: 'active',
    };

    for (const day of [
      Date.UTC(2026, 0, 31), Date.UTC(2026, 1, 1), Date.UTC(2026, 1, 28),
      Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 2), Date.UTC(2026, 2, 3),
      Date.UTC(2026, 2, 31), Date.UTC(2026, 3, 15), Date.UTC(2027, 1, 28),
    ]) {
      const at = new Date(day + 12 * 3600 * 1000);
      const window = subs.usageWindow(subscription, at);
      check(`the window contains ${at.toISOString().slice(0, 10)}`,
        new Date(window.periodStart) <= at && new Date(window.periodEnd) > at,
        `${window.periodStart} .. ${window.periodEnd}`);
    }

    // Consecutive windows have to tile the calendar exactly: a gap is a free
    // allowance and an overlap is one the client paid for and cannot spend.
    let cursor = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
    let previousEnd = null;
    for (let i = 0; i < 14; i += 1) {
      const window = subs.usageWindow(subscription, cursor);
      if (previousEnd) {
        eq(`window ${i} starts exactly where the last one ended`, window.periodStart, previousEnd);
      }
      previousEnd = window.periodEnd;
      cursor = new Date(new Date(window.periodEnd).getTime() + 12 * 3600 * 1000);
    }
  }

  section('Every event the code logs is an event the log accepts');
  {
    /* `scheduled_change_due` was logged by the sweep that promotes a downgrade
       and was missing from EVENT_TYPES, so every one of them was refused at
       the door with a console warning -- the single event that says a client
       changed plans without being asked for money again.                    */
    const eventsLib = require('../utils/membershipEvents');
    for (const type of [
      'scheduled_change_due', 'renewal_due', 'plan_lapsed', 'plan_choice_expired',
      'request_deferred', 'non_update_overused', 'request_recategorised',
    ]) {
      check(`${type} is a known event type`, eventsLib.EVENT_TYPES.includes(type));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
