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

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

/**
 * Builds a full backend URL for a given `/api/...` path. Use this (not a
 * hardcoded "/api/..." string) anywhere the app needs a real URL outside of
 * `api()` itself -- e.g. an <a href> file download link or a redirect --
 * so it keeps working when the frontend and backend are deployed to
 * different origins (VITE_API_BASE_URL set) as well as when they share one.
 */
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
      // "include" (not "same-origin") so the session cookie still goes out
      // when VITE_API_BASE_URL points at a different origin than the
      // frontend itself -- same-origin deployments are unaffected either way.
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network failure, DNS error, backend unreachable, etc. Surface this
    // honestly instead of pretending the request succeeded.
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status);
  }

  return (await res.json().catch(() => ({}))) as T;
}

/**
 * Same contract as api(), but for multipart/form-data uploads. No
 * "Content-Type" header is set here -- the browser sets it, including the
 * multipart boundary, only when it builds the request body itself.
 */
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

  return (await res.json().catch(() => ({}))) as T;
}
