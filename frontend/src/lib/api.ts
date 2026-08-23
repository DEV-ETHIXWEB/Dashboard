let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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

export function apiUrl(path: string): string {
  return `${BASE_URL}/api${path}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status);
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
    throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status);
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
