let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  status: number;
  /**
   * The rest of the failure body, when the server sent one.
   *
   * Most callers only ever want `message`, which is why it stays the first
   * argument. A few need a machine-readable discriminator alongside it -- the
   * set-password page has to tell "expired" from "already used" to say
   * something useful -- and losing that meant either parsing English or adding
   * a second request. Never populated for a network failure, where there is no
   * body to speak of.
   */
  payload: Record<string, unknown>;
  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

/**
 * A write that was parked for a second signature rather than carried out.
 *
 * The server answers 202 for these, which `fetch` reports as success and every
 * `onSuccess` handler then reports as "deleted" / "revoked" / "updated" -- a
 * screen telling someone a thing happened when the whole point of the queue is
 * that it has not. Raising it instead makes the safe reading the default: a
 * caller that says nothing about approvals now shows the server's own "sent for
 * approval" line through its error path, and only callers that want to dress it
 * up differently need to know this type exists.
 */
export class HeldForApproval extends ApiError {
  request: unknown;
  constructor(message: string, request: unknown) {
    super(message, 202);
    this.name = "HeldForApproval";
    this.request = request;
  }
}

/** Whether a rejected mutation was actually parked for approval, not refused. */
export function isHeldForApproval(err: unknown): err is HeldForApproval {
  return err instanceof HeldForApproval;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

/**
 * Reads that are already on the wire.
 *
 * React Query dedupes by query key, which covers the screens; it does not cover
 * the calls made outside it. `/auth/me` in particular is read on mount, again
 * when a sign-in completes, and again whenever the live stream reports the
 * session changed -- three requests that can overlap inside a second and can
 * only agree with each other. Anything arriving while an identical GET is still
 * in flight waits for that one instead of opening its own.
 *
 * Only GETs, and only until the response lands. Nothing is held afterwards:
 * deciding how long an answer stays good is `queryCache.ts`'s job, and a second
 * opinion about it here is how caches start disagreeing with themselves.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * What the app asked the server for, in order, with how long each took.
 *
 * Development only -- `import.meta.env.DEV` is a compile-time constant, so the
 * whole thing including this array is dropped from a production build. Read it
 * from the console as `__apiLog`, or `__apiLog.slowest()` when a screen feels
 * heavy and you want to know which read to blame.
 */
interface ApiLogEntry {
  method: string;
  path: string;
  status: number;
  ms: number;
  /** True when this call rode along on a request that was already open. */
  shared: boolean;
  at: number;
}

const apiLog: ApiLogEntry[] = [];
const API_LOG_LIMIT = 500;

function record(entry: ApiLogEntry) {
  if (!import.meta.env.DEV) return;
  apiLog.push(entry);
  if (apiLog.length > API_LOG_LIMIT) apiLog.shift();
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__apiLog = {
    get entries() {
      return [...apiLog];
    },
    /** Which endpoints were asked for most, and what they cost in total. */
    summary() {
      const byPath = new Map<string, { calls: number; shared: number; totalMs: number }>();
      for (const e of apiLog) {
        const id = `${e.method} ${e.path.split("?")[0]}`;
        const row = byPath.get(id) ?? { calls: 0, shared: 0, totalMs: 0 };
        row.calls += 1;
        // A shared call cost nothing; averaging its zero in would make a slow
        // endpoint look fast for having been asked for twice at once.
        if (e.shared) row.shared += 1;
        else row.totalMs += e.ms;
        byPath.set(id, row);
      }
      return [...byPath.entries()]
        .map(([id, row]) => ({
          ...row,
          id,
          avgMs: row.calls > row.shared ? Math.round(row.totalMs / (row.calls - row.shared)) : 0,
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
    },
    slowest(n = 10) {
      return [...apiLog].sort((a, b) => b.ms - a.ms).slice(0, n);
    },
    clear() {
      apiLog.length = 0;
    },
  };
}

export function apiUrl(path: string): string {
  return `${BASE_URL}/api${path}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (method !== "GET") return request<T>(method, path, body);

  const open = inFlight.get(path);
  if (open) {
    record({ method, path, status: 0, ms: 0, shared: true, at: Date.now() });
    return open as Promise<T>;
  }

  const pending = request<T>(method, path, body).finally(() => inFlight.delete(path));
  inFlight.set(path, pending);
  return pending;
}

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const started = performance.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    record({ method, path, status: 0, ms: performance.now() - started, shared: false, at: Date.now() });
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }

  record({ method, path, status: res.status, ms: performance.now() - started, shared: false, at: Date.now() });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(
      (data as { error?: string }).error || `Request failed (${res.status})`,
      res.status,
      data as Record<string, unknown>,
    );
  }

  const payload = (await res.json().catch(() => ({}))) as T;

  if (res.status === 202 && (payload as { pendingApproval?: boolean })?.pendingApproval) {
    const held = payload as { message?: string; request?: unknown };
    throw new HeldForApproval(
      held.message || "Sent to the other admins for approval. Nothing has changed yet.",
      held.request,
    );
  }

  return payload;
}

export async function apiUpload<T = unknown>(path: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers,
      body: formData,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(
      (data as { error?: string }).error || `Request failed (${res.status})`,
      res.status,
      data as Record<string, unknown>,
    );
  }

  const payload = (await res.json().catch(() => ({}))) as T;

  if (res.status === 202 && (payload as { pendingApproval?: boolean })?.pendingApproval) {
    const held = payload as { message?: string; request?: unknown };
    throw new HeldForApproval(
      held.message || "Sent to the other admins for approval. Nothing has changed yet.",
      held.request,
    );
  }

  return payload;
}
