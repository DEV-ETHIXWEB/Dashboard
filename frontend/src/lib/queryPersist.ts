/**
 * The part of the cache that survives a reload.
 *
 * In-memory caching makes moving between screens instant, but pressing refresh
 * empties it, and the app then re-fetches its own vocabulary -- the public
 * config, the ticket stages, which integrations are connected -- before it can
 * draw anything. Those answers are the same for everyone and change on a
 * deploy, so they are worth keeping.
 *
 * Nothing else is. `sw.js` has always refused to write `/api/` responses to
 * disk on the grounds that a shared or stolen phone should not be trawlable
 * for a client's invoices after sign-out, and widening the cache is not a
 * reason to give that up. So the allowlist here is not a performance
 * judgement, it is a privacy one: only answers that are not about a person are
 * eligible, marked `persist: true` in `queryCache.ts`, and even those live in
 * session storage -- per tab, gone when the tab closes -- rather than in local
 * storage. Sign-out wipes them early.
 *
 * If a future change makes it worth persisting real workspace data, this is
 * the file to argue about, and the argument has to cover shared devices.
 */

import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { isPersistable } from "@/lib/queryCache";

const STORAGE_KEY = "ethixweb:query-cache";

/**
 * Bump when the shape of anything persisted changes. A mismatch throws the
 * stored copy away rather than hydrating last week's idea of a config object
 * into this week's components.
 */
const CACHE_VERSION = "1";

/** Older than this and we would rather ask the server than guess. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Writes wait for a quiet moment; a burst of queries settling is one write. */
const WRITE_DELAY_MS = 1000;

interface Envelope {
  version: string;
  savedAt: number;
  state: unknown;
}

function storage(): Storage | null {
  try {
    // Private modes and locked-down browsers throw on access, not on use.
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Read the stored cache back into a fresh client. Call before the first render. */
export function restoreQueryCache(client: QueryClient): void {
  const store = storage();
  if (!store) return;

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return;

    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.version !== CACHE_VERSION || Date.now() - envelope.savedAt > MAX_AGE_MS) {
      store.removeItem(STORAGE_KEY);
      return;
    }

    hydrate(client, envelope.state);
  } catch {
    // A corrupt entry is not worth failing a boot over. Start cold instead.
    clearPersistedCache();
  }
}

/**
 * Keep writing the allowlisted part of the cache back to session storage.
 *
 * Returns the unsubscribe, which nothing currently calls -- the subscription is
 * meant to last as long as the tab.
 */
export function persistQueryCache(client: QueryClient): () => void {
  const store = storage();
  if (!store) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    timer = null;
    try {
      const state = dehydrate(client, {
        shouldDehydrateQuery: (query) =>
          query.state.status === "success" && isPersistable(query.queryKey),
      });
      const envelope: Envelope = { version: CACHE_VERSION, savedAt: Date.now(), state };
      store.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Quota, or a payload that will not stringify. Neither is worth a crash;
      // the app simply starts cold next time.
    }
  };

  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (!isPersistable(event.query.queryKey)) return;
    if (timer == null) timer = setTimeout(write, WRITE_DELAY_MS);
  });

  return () => {
    if (timer != null) clearTimeout(timer);
    unsubscribe();
  };
}

/** Sign-out, and any hydration we could not trust. */
export function clearPersistedCache(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}
