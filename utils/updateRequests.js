'use strict';

/**
 * Whether a client may raise this request, and what it costs them if not.
 *
 * The rule, in one place:
 *
 *   Basic        hosting only. An outage or a billing question always gets
 *                through; a change request does not, and is answered with the
 *                offer of Managed rather than a closed door.
 *   Managed      two changes a month included. The third is **not refused** --
 *                the work still gets done, we quote it per job and charge for
 *                it. They can also wait for the reset, or upgrade.
 *   Unlimited    no cap.
 *
 * Nothing here ever throws away what somebody typed. Every refusal comes back
 * as a decision for the client to make, with their text still in the form, and
 * the three ways forward named. A support form that loses a paragraph because
 * of a billing rule is how you turn a sale into a complaint.
 */

const { db } = require('../db/setup');
const plans = require('../lib/plans');
const subscriptions = require('./subscriptions');
const events = require('./membershipEvents');

/**
 * Decide what happens to one request, without writing anything.
 *
 * Returns `{ ok }` when it may go straight through, or `{ ok: false, reason }`
 * with everything a screen needs to explain itself. Separated from the
 * consuming step so a route can ask the question, and so the ticket form can
 * ask it before somebody has typed four paragraphs.
 */
async function check(client, { category } = {}) {
  const state = await subscriptions.stateFor(client);
  const planKey = state.effectivePlanKey;

  // No plan and not yet enforced: the grandfather clause. They keep what they
  // had this morning, and the banner is what asks them to choose.
  if (!planKey) {
    return state.grandfathered
      ? { ok: true, state, counts: false }
      : {
        ok: false,
        reason: 'no_plan',
        state,
        message: 'Your site needs an active plan before we can take requests.',
        recommended: 'managed',
      };
  }

  const plan = plans.planFor(planKey);

  // --- the category gate -------------------------------------------------
  if (!plans.canFileCategory(planKey, category)) {
    return {
      ok: false,
      reason: 'category_not_included',
      state,
      planKey,
      message: `${plan.name} is hosting only, so changes to your site are not included. `
        + 'We will handle 2 changes a month for you on Managed.',
      recommended: plans.recommendedUpgradeFor(planKey) || 'managed',
    };
  }

  // --- does this even count? ---------------------------------------------
  // An outage is not a change. Neither is a billing question. Letting either
  // consume one of two monthly updates would be indefensible.
  if (!plans.isUpdateRequest(category)) {
    return { ok: true, state, counts: false };
  }

  if (plan.updateRequestsPerMonth === null) {
    return { ok: true, state, counts: false };
  }

  const usage = state.usage;
  if (usage.remaining === null || usage.remaining > 0) {
    return { ok: true, state, counts: true, usage };
  }

  // --- out of allowance ---------------------------------------------------
  // Not a refusal. The work gets done; this is the client choosing how.
  return {
    ok: false,
    reason: 'allowance_used',
    state,
    planKey,
    usage,
    message: `You have used your ${usage.included} updates for this month. `
      + `Your next ${usage.included} unlock on ${formatDate(usage.resetsAt)}.`,
    resetsAt: usage.resetsAt,
    chargeable: plan.extraUpdatesChargeable,
    recommended: plans.recommendedUpgradeFor(planKey),
  };
}

/**
 * Take one off the allowance, atomically.
 *
 * `db.incrementIfBelow` is one statement on Postgres and a transaction on
 * Firestore. A read-then-write here would let two requests submitted in the
 * same second both see "1 of 2 used" and both go through, which is the bug
 * this exists to avoid -- and the counter row's id is derived from the client
 * and the month so the two cannot even create separate counters to race in.
 *
 * Returns false when the allowance was already gone, so a caller that somehow
 * reached here without checking still cannot overspend it.
 *
 * Counted against the subscription that *governs*, which is the same one
 * `check` measured the allowance against -- not merely the `active` one. Three
 * statuses govern: active, past_due, and a cancellation that has not run out.
 * Reading only the active row here would mean a client whose card failed, or
 * who cancelled and is still inside the period they paid for, had two updates
 * on their billing page and no window to spend them in -- and the route reads
 * a false return as "that used the last of your updates", so they would be
 * refused outright with the full allowance showing.
 */
async function consume(clientId, state) {
  const window = subscriptions.usageWindow(await subscriptions.governingFor(clientId));
  if (!window) return false;

  const plan = plans.planFor(state.effectivePlanKey);
  const included = plan ? plan.updateRequestsPerMonth : null;
  if (included === null || included === 0) return false;

  const id = subscriptions.usageId(clientId, window.periodStart);
  await ensureCounter(id, clientId, window);

  const row = await db.incrementIfBelow('update_request_usage', id, 'count', included);
  return Boolean(row);
}

/**
 * Count one request past the allowance, which we quote and charge for.
 *
 * Deliberately a different column from `count`: "2 of 2 used" and "1 extra,
 * quoted separately" are different facts to the person paying, and adding them
 * together would tell a Managed client they had used three of two. No ceiling,
 * because past the included two the answer is a price, not a refusal.
 */
async function consumeExtra(clientId, state) {
  // The governing subscription, for the same reason as `consume` above.
  const window = subscriptions.usageWindow(await subscriptions.governingFor(clientId));
  if (!window) return false;

  const id = subscriptions.usageId(clientId, window.periodStart);
  await ensureCounter(id, clientId, window);

  // The one atomic primitive both drivers have, with a ceiling nobody reaches.
  const row = await db.incrementIfBelow(
    'update_request_usage', id, 'extraCount', Number.MAX_SAFE_INTEGER,
  );
  if (row) {
    await events.log('extra_update_purchased', {
      clientId,
      metadata: { planKey: state.effectivePlanKey, extraCount: Number(row.extraCount || 0) },
    });
  }
  return Boolean(row);
}

/**
 * Create the counter if this is the month's first request.
 *
 * The insert is allowed to fail. Its id is derived from the client and the
 * month, so a second caller racing for the same row is refused by the primary
 * key -- which is exactly the intended outcome, because the row it wanted now
 * exists. Swallowing that specific failure is the point, not an oversight.
 */
async function ensureCounter(id, clientId, window) {
  const existing = await db.find('update_request_usage', id);
  if (existing) return existing;

  try {
    return await db.insert('update_request_usage', {
      id,
      clientId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      count: 0,
      extraCount: 0,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // Somebody else created it between the read and the write. Theirs is fine.
    return db.find('update_request_usage', id);
  }
}

/**
 * Hold a request until the allowance resets.
 *
 * Not a ticket. A ticket is work the team owes an answer on with an SLA clock
 * running, and this has not been agreed to as work yet -- putting it in the
 * queue would start a clock nobody signed up for and bury the real queue.
 */
async function queue(clientId, { subject, category, description, priority, releaseAt }) {
  const row = await db.insert('queued_requests', {
    clientId,
    subject,
    category: category || 'General',
    description: description || '',
    priority: priority || 'Normal',
    releaseAt,
    createdAt: new Date().toISOString(),
  });

  await events.log('request_queued', {
    clientId,
    metadata: { category: category || 'General', releaseAt },
  });

  return row;
}

/** What this client is holding for next month. */
async function queuedFor(clientId) {
  // This client's held requests from the database; still-open in memory, so a
  // row whose stamps were never set reads the same as it always did.
  const rows = (await db.where('queued_requests', { clientId }))
    .filter((q) => !q.releasedAt && !q.cancelledAt);
  return rows.sort((a, b) => String(a.releaseAt || '').localeCompare(String(b.releaseAt || '')));
}

/**
 * Turn held requests into real tickets once their reset date has passed.
 *
 * A request somebody saved for next month and that nobody ever picked up is
 * worse than refusing it outright, so this runs off ordinary API traffic the
 * way the outbox sweep does rather than depending on a scheduler nobody set
 * up. Throttled to once a minute, with an in-flight guard, because this is
 * called on every request.
 *
 * Each release consumes one of the new month's updates, which is the whole
 * point: the client chose to spend a future allowance rather than pay for an
 * extra. If the allowance is already gone -- they raised two others first --
 * the request stays held and rolls to the month after rather than becoming a
 * silent free update.
 */
let lastSweep = 0;
let sweeping = false;

async function maybeSweep() {
  if (sweeping) return;
  if (Date.now() - lastSweep < 60_000) return;
  sweeping = true;
  lastSweep = Date.now();
  try {
    await releaseDue();
  } catch (err) {
    console.error(`[updates] could not release held requests: ${err.message}`);
  } finally {
    sweeping = false;
  }
}

async function releaseDue(now = new Date()) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const due = await db.filter(
    'queued_requests',
    (q) => !q.releasedAt && !q.cancelledAt && q.releaseAt && String(q.releaseAt) <= at,
  );
  if (due.length === 0) return 0;

  const intake = require('./ticketIntake');
  let released = 0;

  for (const held of due) {
    try {
      const client = await db.find('users', held.clientId);
      if (!client) continue;

      const state = await subscriptions.stateFor(client);
      const plan = plans.planFor(state.effectivePlanKey);

      // Still capped, and still out? Leave it held. Releasing anyway would
      // hand out a free update, and cancelling it would throw away something
      // the client asked us to keep.
      if (plan && plan.updateRequestsPerMonth !== null && plan.updateRequestsPerMonth > 0) {
        const took = await consume(held.clientId, state);
        if (!took) continue;
      }

      const priority = intake.normalizePriority(held.priority);
      const ticket = await db.insert('tickets', {
        id: await intake.nextTicketId(),
        subject: held.subject,
        category: held.category || 'General',
        clientId: held.clientId,
        assigneeId: null,
        status: 'Open',
        description: held.description || '',
        createdAt: new Date().toISOString(),
        priority,
        responseDueAt: intake.responseDueAt(priority),
        firstResponseAt: null,
      });

      // Marked before the announcement. A failure to reach Slack must not
      // cause this to be released a second time on the next sweep.
      await db.update('queued_requests', held.id, {
        releasedAt: new Date().toISOString(),
        ticketId: ticket.id,
      });

      await intake.onTicketCreated(ticket);
      released += 1;
    } catch (err) {
      console.error(`[updates] could not release ${held.id}: ${err.message}`);
    }
  }

  return released;
}

function formatDate(value) {
  if (!value) return 'your billing day';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'your billing day';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

module.exports = { check, consume, consumeExtra, queue, queuedFor, ensureCounter, releaseDue, maybeSweep };
