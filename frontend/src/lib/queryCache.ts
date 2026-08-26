/**
 * One place that says how long every read is allowed to be trusted.
 *
 * Before this file each screen decided for itself, and most of them decided
 * nothing at all -- React Query's default stale time is zero, so leaving
 * Projects and coming back refetched the whole list, spinner and all, for data
 * the tab had received four seconds earlier. Thirteen screens behaved that way.
 * Navigation felt like a page load because, in network terms, it was one.
 *
 * The reason a long stale time is safe here is the live wire. `useLiveUpdates`
 * holds an SSE stream and invalidates the affected keys the moment anything
 * changes, for every topic in `live.ts` -- which is to say for nearly every
 * piece of workspace data below. Freshness comes from being told, not from
 * asking, so these numbers only cover the gap between a change and its
 * announcement. When the stream cannot connect at all, the same hook falls back
 * to refetching everything on screen every thirty seconds, which is a second
 * safety net under this one.
 *
 * Add an endpoint to `TIERS` when you add a hook. A key with no entry gets
 * `NORMAL`, which is the right answer often enough that forgetting is not a
 * bug -- but naming it here is how the next person finds out what this app
 * considers current.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export interface CacheTier {
  /** How long a cached answer is served without asking the server again. */
  staleTime: number;
  /**
   * Background poll, as a safety net for hosts that accept the SSE stream and
   * then quietly buffer it. Only runs while the tab is visible: React Query
   * does not poll a backgrounded tab unless asked to, and we never ask.
   */
  refetchInterval?: number;
  /**
   * Whether this answer may be written to session storage and read back after
   * a reload. Off for everything that is somebody's data -- see `queryPersist`
   * for why the line is drawn where it is.
   */
  persist?: boolean;
}

/** Configuration and vocabulary. Changes on a deploy, not during a session. */
const STATIC: CacheTier = { staleTime: Infinity, persist: true };

/** Third-party structure -- spaces, lists, channels, members. Rarely moves. */
const SLOW: CacheTier = { staleTime: 10 * MINUTE };

/** Workspace records that change a few times a day, and announce it when they do. */
const STEADY: CacheTier = { staleTime: 5 * MINUTE };

/** The working set: whatever the team is actually editing today. */
const NORMAL: CacheTier = { staleTime: 2 * MINUTE };

/** Arrives unprompted and is read at a glance, so it gets a poll of its own. */
const FRESH: CacheTier = { staleTime: 30 * SECOND, refetchInterval: 2 * MINUTE };

/** Codes and secrets. Never reused across a mount, never persisted. */
const SENSITIVE: CacheTier = { staleTime: 0 };

/**
 * How long an unused answer is kept before it is thrown away.
 *
 * This is the number that makes navigation instant: a cache entry has to
 * outlive the screen that created it, or every visit starts from nothing no
 * matter what the stale time says. Half an hour covers a working session of
 * moving between pages; the tab still drops everything on sign-out.
 */
export const DEFAULT_GC_TIME = 30 * MINUTE;

/**
 * Longest matching key prefix wins, so `["integrations", "clickup", "tree"]`
 * can be pinned without disturbing the rest of `["integrations"]`.
 */
const TIERS: { key: string[]; tier: CacheTier }[] = [
  // Configuration and vocabulary.
  { key: ["config"], tier: STATIC },
  { key: ["ticket-stages"], tier: STATIC },

  // Workspace data. Every one of these is on a live topic, so the number below
  // only decides how long a screen may open without asking -- not whether what
  // it shows is right. A change anywhere invalidates the key within a quarter
  // of a second.
  { key: ["users"], tier: STEADY },
  { key: ["domains"], tier: STEADY },
  { key: ["reports"], tier: STEADY },
  { key: ["billing"], tier: STEADY },
  { key: ["budget"], tier: STEADY },
  { key: ["projects"], tier: NORMAL },
  { key: ["tasks"], tier: NORMAL },
  { key: ["tickets"], tier: NORMAL },
  { key: ["ticket-timeline"], tier: NORMAL },
  { key: ["payments"], tier: NORMAL },
  { key: ["approvals"], tier: NORMAL },
  { key: ["audit-log"], tier: NORMAL },

  // The progress board also mirrors ClickUp, and nothing tells this app when
  // somebody drags a card over there. It keeps the poll it was written with.
  { key: ["client-progress"], tier: { staleTime: 30 * SECOND, refetchInterval: MINUTE } },
  { key: ["client-progress", "activity"], tier: { staleTime: 15 * SECOND } },

  // Things a person watches for rather than navigates to. Each is pushed on a
  // live topic; the interval is the safety net for a stream that is being
  // quietly buffered somewhere between here and the server.
  { key: ["notifications"], tier: FRESH },
  { key: ["client-channel"], tier: FRESH },
  { key: ["ticket-requests"], tier: FRESH },
  { key: ["otp-logs"], tier: { staleTime: 15 * SECOND, refetchInterval: MINUTE } },

  // Integrations. A remote API is the slow part of every one of these, and none
  // of them are on the live wire, so they are cached hardest.
  { key: ["integrations"], tier: { staleTime: MINUTE } },
  { key: ["integrations", "status"], tier: { ...STEADY, persist: true } },
  { key: ["integrations", "clickup", "tree"], tier: SLOW },
  { key: ["integrations", "clickup", "members"], tier: SLOW },
  // A list's own set of statuses is part of how the workspace is configured.
  { key: ["integrations", "clickup", "statuses"], tier: { staleTime: 60 * MINUTE } },
  { key: ["integrations", "slack", "channels"], tier: SLOW },
  { key: ["integrations", "slack", "feed"], tier: NORMAL },
  { key: ["integrations", "slack", "messages"], tier: NORMAL },

  { key: ["mail"], tier: { staleTime: MINUTE } },
  { key: ["mail", "templates"], tier: { staleTime: 10 * MINUTE, persist: true } },
  { key: ["mail", "preview"], tier: { staleTime: 10 * MINUTE } },
  { key: ["mail", "log-entry"], tier: { staleTime: 5 * MINUTE } },
  { key: ["mail", "log"], tier: FRESH },

  // Never held: the server hands these over once and cannot produce them again.
  { key: ["recovery-codes"], tier: SENSITIVE },
];

function matches(prefix: string[], queryKey: readonly unknown[]): boolean {
  if (prefix.length > queryKey.length) return false;
  return prefix.every((part, i) => queryKey[i] === part);
}

/** The tier for a key, longest matching prefix first. */
export function tierFor(queryKey: readonly unknown[]): CacheTier {
  let best: CacheTier = NORMAL;
  let bestLength = -1;
  for (const { key, tier } of TIERS) {
    if (key.length > bestLength && matches(key, queryKey)) {
      best = tier;
      bestLength = key.length;
    }
  }
  return best;
}

export function staleTimeFor(queryKey: readonly unknown[]): number {
  return tierFor(queryKey).staleTime;
}

export function refetchIntervalFor(queryKey: readonly unknown[]): number | false {
  return tierFor(queryKey).refetchInterval ?? false;
}

/** Whether this key may survive a reload. See `queryPersist`. */
export function isPersistable(queryKey: readonly unknown[]): boolean {
  return tierFor(queryKey).persist === true;
}
