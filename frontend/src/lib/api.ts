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

  return (await res.json().catch(() => ({}))) as T;
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

  return (await res.json().catch(() => ({}))) as T;
}
