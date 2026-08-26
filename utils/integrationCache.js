'use strict';

// Shared plumbing for the Slack and ClickUp clients: an in-process TTL cache,
// and the bounded fan-out both of them read their pages with.
//
// Integration data is fetched live from Slack/ClickUp, so the cache exists
// partly to keep us under their rate limits when several admins have the page
// open at once, and partly because a round trip to either takes long enough to
// be felt.

const store = new Map();
const inflight = new Map();

const DEFAULT_TTL_MS = 60 * 1000;

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlMs = DEFAULT_TTL_MS, staleMs = 0) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    // How long past expiry the old answer may still be handed out while a
    // fresh one is fetched behind it. Zero means the old answer is worthless
    // the moment it expires, which is the original behaviour.
    staleUntil: Date.now() + ttlMs + staleMs,
  });
  return value;
}

function start(key, producer, ttlMs, staleMs) {
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => producer())()
    .then((value) => {
      set(key, value, ttlMs, staleMs);
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

/**
 * Run `producer` at most once per key per TTL window. Concurrent callers share
 * the same in-flight promise instead of each firing their own upstream request.
 *
 * `staleMs` turns the wait into a background one. Slack and ClickUp answer in
 * seconds, not milliseconds, so whoever happens to open the page the moment a
 * TTL lapses pays the full upstream cost for everybody -- on the Slack feed
 * that was a multi-second stall roughly every two minutes, landing on a
 * different person each time. With a stale window the expired answer is handed
 * over immediately and the refresh happens behind it, so the wait is only ever
 * paid by the first person to ask for something nobody has asked for yet.
 *
 * The cost is age: an answer can be up to `ttlMs + staleMs` old. Pick the
 * window per call site accordingly, and leave it at zero for anything a person
 * expects to see change the instant they act on it.
 */
async function cached(key, producer, ttlMs = DEFAULT_TTL_MS, staleMs = 0) {
  const hit = store.get(key);

  if (hit) {
    const now = Date.now();
    if (hit.expiresAt >= now) return hit.value;

    if (hit.staleUntil >= now) {
      // Kick the refresh off and hand back what we have. The failure is
      // swallowed on purpose: nobody is waiting on this promise, and an
      // unhandled rejection here would take the process down over a Slack
      // hiccup that the next real request will report properly anyway.
      start(key, producer, ttlMs, staleMs).catch(() => {});
      return hit.value;
    }

    store.delete(key);
  }

  return start(key, producer, ttlMs, staleMs);
}

/** Run `task` over `items`, at most `limit` at a time, results in input order. */
async function mapWithLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Both clients read several things at once -- Slack a channel per request,
 * ClickUp a page per request -- and both are rate limited, so neither may
 * simply fire everything at the API and hope.
 */
function invalidate(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { cached, get, set, invalidate, mapWithLimit, DEFAULT_TTL_MS };
