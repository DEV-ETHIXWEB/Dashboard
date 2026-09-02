'use strict';

/**
 * The thing that actually notices a delivery has come due.
 *
 * Built the same way as utils/slaWatch.js and utils/domainWatch.js, and for the
 * same reason those exist: this app is deployed to a platform where a process
 * is not guaranteed to be alive between requests, so a `setInterval` at boot is
 * not a scheduler -- it is a scheduler on a laptop that silently does nothing
 * in production. So the sweep rides on traffic (any admin request may trigger
 * it, at most once every couple of minutes), an admin can run it by hand, and
 * a long-lived deployment can additionally arm a real timer -- see
 * `startTimer` and the call in server.js.
 *
 * Three separate things keep it honest under all of those at once:
 *
 *   - `inFlight` stops one process running two sweeps over each other
 *   - the interval floor stops a busy dashboard hammering the database
 *   - the atomic claim in credentialDelivery.deliver() stops two *processes*
 *     sending the same email, which the first two cannot help with
 *
 * The third is the one that matters. The first two are politeness.
 */

const { db } = require('../db/setup');
const delivery = require('./credentialDelivery');
const live = require('./liveBus');

const MINUTE_MS = 60 * 1000;

/** Floor between sweeps, so a busy admin session cannot hammer the database. */
const SWEEP_INTERVAL_MS = 2 * MINUTE_MS;

/** How often an armed timer looks, on a deployment that keeps a process alive. */
const TIMER_INTERVAL_MS = 60 * MINUTE_MS;

let lastSweepAt = 0;
let inFlight = null;
let timer = null;

/** Deliveries that are booked, due, and not already being sent. */
async function dueNow(now = Date.now()) {
  const rows = await db.filter(
    'credential_deliveries',
    (row) => row.status === 'scheduled' && Number(row.scheduledAt) <= now,
  );
  return rows.sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt));
}

/**
 * Run the sweep now. Returns what it looked at and what it acted on.
 *
 * Never throws for one bad delivery: a single unreachable inbox must not stop
 * the other nine from going out.
 */
async function runSweep() {
  lastSweepAt = Date.now();

  // A claim whose process died mid-send would otherwise sit in 'sending' for
  // ever and never be picked up by anybody, including a manual retry.
  const released = await db.releaseStaleCredentialClaims(delivery.STALE_CLAIM_MS);
  if (released.length > 0) {
    console.warn(`[credentials] released ${released.length} stale delivery claim(s) back to the queue`);
  }

  const due = await dueNow();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due) {
    try {
      const result = await delivery.deliver(row.id);
      if (result.sent) sent += 1;
      else if (result.failed) failed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(`[credentials] delivery ${row.id} threw:`, err.message);
    }
  }

  // Only when something moved. An empty sweep every two minutes that nudged
  // every open dashboard would be a refetch storm about nothing.
  if (sent > 0 || failed > 0) live.publish('users');

  return { due: due.length, sent, failed, skipped, released: released.length };
}

/**
 * Run at most once per interval, and never twice at the same time. Safe to call
 * from a request handler without awaiting.
 */
async function maybeSweep() {
  if (inFlight) return inFlight;
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  inFlight = runSweep()
    .catch((err) => {
      console.error('The credential delivery sweep failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Arm a real timer, for a deployment that keeps a process alive.
 *
 * Without this, a delivery booked for 3am on a quiet workspace waits until the
 * first person signs in and happens to load a page that sweeps. With it, the
 * schedule means what it says. Called only from the `require.main === module`
 * branch of server.js, so importing the app -- serverless, tests -- never
 * starts a timer nobody asked for. `unref` so it can never hold the process
 * open on its own.
 */
function startTimer() {
  if (timer) return timer;
  if (String(process.env.CREDENTIAL_SCHEDULER_TIMER || '').toLowerCase() === 'off') return null;

  timer = setInterval(() => {
    runSweep().catch((err) => console.error('The scheduled credential sweep failed:', err.message));
  }, TIMER_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runSweep, maybeSweep, dueNow, startTimer, stopTimer, SWEEP_INTERVAL_MS, TIMER_INTERVAL_MS };
