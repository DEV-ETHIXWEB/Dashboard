'use strict';

// Small in-process TTL cache. Integration data is fetched live from Slack/ClickUp,
// so this exists purely to keep us under their rate limits when several admins
// have the page open at once.

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

function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/**
 * Run `producer` at most once per key per TTL window. Concurrent callers share
 * the same in-flight promise instead of each firing their own upstream request.
 */
async function cached(key, producer, ttlMs = DEFAULT_TTL_MS) {
  const hit = get(key);
  if (hit !== undefined) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => producer())()
    .then((value) => {
      set(key, value, ttlMs);
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

function invalidate(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { cached, get, set, invalidate, DEFAULT_TTL_MS };
