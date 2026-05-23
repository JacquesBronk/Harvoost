// Thin fetch wrapper around the Harvoost REST API (web app).
//
// Conventions (see 03-api-design/API_NOTES.md):
//   - HttpOnly `harvoost_session` cookie via `credentials: 'include'`.
//     The browser attaches it automatically; no client-side cookie reads.
//   - `X-Requested-With: XMLHttpRequest` paired with the backend CSRF middleware.
//   - Uniform error envelope: { code, message, details? } on non-2xx.
//   - ISO 8601 with explicit offset for all date-time values.
//   - Idempotency-Key required for time-entries start/stop/switch.
//
// Note: apps/tray uses bearer-from-keytar and ships its own fetch client; this
// module is web-only.

import { env } from './env.js';

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.details = payload.details;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  // Retained for backwards compatibility with callers that pass `token: null` to
  // indicate "no auth yet" (e.g. the OIDC callback page). The web app no longer
  // attaches a Bearer header — the browser sends the HttpOnly session cookie
  // automatically via `credentials: 'include'`. apps/tray continues to use
  // bearer-from-keytar and ships its own fetch client.
  token?: string | null;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = env.API_BASE_URL.replace(/\/$/, '');
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, query, headers = {}, signal } = options;

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...headers,
  };
  if (body !== undefined) {
    finalHeaders['Content-Type'] ??= 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal,
    });
  } catch (err) {
    // Network-level error (no DNS, server down, CORS hard block, abort, etc.).
    if ((err as { name?: string }).name === 'AbortError') {
      throw err;
    }
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: 'Could not reach the Harvoost API. Check your connection and try again.',
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: unknown = undefined;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Non-JSON body — keep as undefined and rely on status.
    }
  }

  if (!response.ok) {
    const envelope =
      payload && typeof payload === 'object'
        ? (payload as Partial<ApiErrorPayload>)
        : undefined;
    throw new ApiError(response.status, {
      code: envelope?.code ?? 'UNKNOWN_ERROR',
      message: envelope?.message ?? `Request failed (${response.status}).`,
      details: envelope?.details,
    });
  }

  return payload as T;
}

/**
 * RFC 4122 UUIDv7-shaped identifier (best-effort; uses crypto.randomUUID
 * if available — that is v4 but acceptable for idempotency since we just
 * need uniqueness, not sortability for our 5-minute dedupe window).
 *
 * TODO(build-phase-followup): swap for a real UUIDv7 generator
 * (e.g. `uuidv7` npm package) when added to dependencies.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: very low entropy random string. Should never run in modern browsers.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const friendlyErrorMessages: Record<string, string> = {
  RBAC_FORBIDDEN: 'You do not have access to this resource.',
  ENTRY_LOCKED: 'This time entry is locked for editing.',
  CHATBOT_DISABLED:
    'The chatbot is currently unavailable. Please contact your administrator.',
  IDEMPOTENCY_CONFLICT: 'A conflicting request is already in progress.',
  VALIDATION_FAILED: 'Please check the form and try again.',
  NOT_FOUND: 'The item you are looking for could not be found.',
  RATE_LIMITED: 'You are sending requests too quickly. Please wait a moment.',
  LLM_UNAVAILABLE: 'The AI service is temporarily unavailable.',
  OIDC_FAILURE: 'Sign-in failed. Please try again.',
  K_ANONYMITY_THRESHOLD: 'Not enough data to show this aggregate (privacy threshold).',
  NETWORK_ERROR: 'Could not reach the Harvoost API.',
};

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return friendlyErrorMessages[err.code] ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
