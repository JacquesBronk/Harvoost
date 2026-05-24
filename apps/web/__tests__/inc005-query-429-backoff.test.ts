import { QueryObserver, type QueryObserverResult } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, parseRetryAfterMs } from '../src/lib/api-client.js';
import {
  makeQueryClient,
  queryRetryDelay,
  shouldRetryQuery,
} from '../src/lib/query-client.js';
import { fetchProjectsForPicker } from '../src/lib/time-entries.js';

/**
 * INC-005 (Fix D, frontend half) — a transient 429 must BACK OFF and RECOVER
 * instead of rendering a hard error across the app.
 *
 * Before this fix, the global React-Query `retry` predicate treated ANY 4xx
 * (including 429) as terminal, so a single throttled read left its panel stuck
 * in an error state with no recovery — only `useCurrentUser` (`/me`) honored the
 * `Retry-After`-aware backoff (#3). Fix D generalizes that backoff to the global
 * query client: 429 becomes a BOUNDED retry honoring the throttler's hint, while
 * every OTHER 4xx stays terminal.
 *
 * Cross-lane contract (matches backend-dev): a throttled READ that 429s carries
 * `Retry-After-global: <seconds>`; login/callback carry `Retry-After-auth`. The
 * backend CORS-exposes `Retry-After-global`, `Retry-After-auth`, `Retry-After`,
 * so `parseRetryAfterMs` (broad fallback) reads the read-429 hint in the browser.
 *
 * Hermetic (vitest, node env, mocked fetch — no live backend), matching the
 * apps/web/__tests__ convention used by INC-003's auth-me-loop.test.ts.
 */

interface ProjectPickerPayload {
  data: Array<{ id: string; name: string }>;
  page: number;
  page_size: number;
  total_count: number;
}

const PROJECTS: ProjectPickerPayload = {
  data: [{ id: 'prj_1', name: 'Internal' }],
  page: 1,
  page_size: 100,
  total_count: 1,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Drive a `QueryObserver` (the same primitive `useQuery` is built on) to a
 * settled `success`/`error` state, advancing fake timers so any scheduled
 * retry backoff fires. Modeling the real consumer this way — rather than the
 * throwing `fetchQuery` — means a terminal error surfaces through observer
 * state instead of a rejected promise (no unhandled-rejection noise) and we can
 * assert on exactly what a rendered panel would see.
 */
async function observeUntilSettled<T>(
  observer: QueryObserver<T>,
): Promise<QueryObserverResult<T>> {
  const unsubscribe = observer.subscribe(() => {});
  try {
    // Let the initial fetch + any retry backoffs (capped at 5s) play out.
    for (let i = 0; i < 10; i++) {
      const result = observer.getCurrentResult();
      if (result.isSuccess || result.isError) return result;
      await vi.advanceTimersByTimeAsync(5_000);
    }
    return observer.getCurrentResult();
  } finally {
    unsubscribe();
  }
}

describe('parseRetryAfterMs (INC-005 read-429 header order)', () => {
  it('prefers `Retry-After-global` (the read bucket after the backend fix)', () => {
    const headers = new Headers({
      'Retry-After-global': '3',
      'Retry-After-auth': '60',
      'Retry-After': '99',
    });
    expect(parseRetryAfterMs(headers)).toBe(3_000);
  });

  it('still reads `Retry-After-auth` (login/callback bucket) when no global', () => {
    const headers = new Headers({ 'Retry-After-auth': '60', 'Retry-After': '99' });
    expect(parseRetryAfterMs(headers)).toBe(60_000);
  });

  it('falls back to a plain `Retry-After` last (robust to bucket renames)', () => {
    expect(parseRetryAfterMs(new Headers({ 'Retry-After': '7' }))).toBe(7_000);
  });

  it('returns undefined when no usable hint is present', () => {
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
    expect(
      parseRetryAfterMs(new Headers({ 'Retry-After-global': 'soon' })),
    ).toBeUndefined();
  });
});

describe('shouldRetryQuery (INC-005 global retry predicate)', () => {
  it('retries a transient 429 with bounded attempts (< 3)', () => {
    const e429 = new ApiError(429, { code: 'RATE_LIMITED', message: '' });
    expect(shouldRetryQuery(0, e429)).toBe(true);
    expect(shouldRetryQuery(2, e429)).toBe(true);
    // Bounded: never storms the bucket.
    expect(shouldRetryQuery(3, e429)).toBe(false);
  });

  it('keeps every OTHER 4xx terminal (no retry) — unchanged from before', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const err = new ApiError(status, { code: 'X', message: '' });
      expect(shouldRetryQuery(0, err)).toBe(false);
    }
  });

  it('still retries 5xx / network with the prior small bound (< 2)', () => {
    const e503 = new ApiError(503, { code: 'UNAVAILABLE', message: '' });
    const eNet = new ApiError(0, { code: 'NETWORK_ERROR', message: '' });
    for (const err of [e503, eNet]) {
      expect(shouldRetryQuery(0, err)).toBe(true);
      expect(shouldRetryQuery(1, err)).toBe(true);
      expect(shouldRetryQuery(2, err)).toBe(false);
    }
  });
});

describe('queryRetryDelay (INC-005 backoff timing)', () => {
  it('honors the throttler hint (retryAfterMs) when present, capped at ~5s', () => {
    const small = new ApiError(
      429,
      { code: 'RATE_LIMITED', message: '' },
      { retryAfterMs: 3_000 },
    );
    expect(queryRetryDelay(0, small)).toBe(3_000);
    // A huge hint is capped so the UI never hangs.
    const huge = new ApiError(
      429,
      { code: 'RATE_LIMITED', message: '' },
      { retryAfterMs: 60_000 },
    );
    expect(queryRetryDelay(0, huge)).toBe(5_000);
  });

  it('falls back to capped exponential backoff when no hint', () => {
    const eNet = new ApiError(0, { code: 'NETWORK_ERROR', message: '' });
    expect(queryRetryDelay(0, eNet)).toBe(1000);
    expect(queryRetryDelay(1, eNet)).toBe(2000);
    expect(queryRetryDelay(2, eNet)).toBe(4000);
    // Capped so a runaway backoff can never hang the UI.
    expect(queryRetryDelay(10, eNet)).toBe(5_000);
  });
});

describe("['projects','picker'] query (INC-005: 429 backs off and RECOVERS)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('a non-/me read that 429s (Retry-After-global) then 200s RECOVERS to data', async () => {
    // First response: throttled read 429 carrying the exposed `Retry-After-global`
    // hint (2s). Second response: the window cleared, 200 with the projects.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          { code: 'RATE_LIMITED', message: 'Too Many Requests' },
          { 'Retry-After-global': '2' },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, PROJECTS));
    globalThis.fetch = fetchMock;

    const client = makeQueryClient();
    // A QueryObserver is exactly what `useQuery` drives; it applies the client's
    // default retry/retryDelay (Fix D). The 429 schedules a 2s backoff from the
    // parsed hint (not an immediate terminal error); the retry then 200s.
    const observer = new QueryObserver(client, {
      queryKey: ['projects', 'picker'],
      queryFn: fetchProjectsForPicker,
    });
    const result = await observeUntilSettled(observer);

    // It did NOT fail to a terminal error state — it recovered to rendered data.
    expect(result.isError).toBe(false);
    expect(result.isSuccess).toBe(true);
    expect(result.data).toEqual(PROJECTS);
    // One 429 + one successful retry = two fetches (bounded, no storm).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The query cache holds success, not error.
    const state = client.getQueryState(['projects', 'picker']);
    expect(state?.status).toBe('success');
    expect(state?.error).toBeNull();

    client.clear();
  });

  it('the parsed retryAfterMs comes from the CORS-exposed `Retry-After-global`', async () => {
    // Prove the hint is actually read off the wire header (the load-bearing part
    // of the cross-lane contract) rather than only the exponential fallback.
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        { code: 'RATE_LIMITED', message: 'Too Many Requests' },
        { 'Retry-After-global': '2' },
      ),
    );
    const thrown = await fetchProjectsForPicker().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(429);
    expect((thrown as ApiError).retryAfterMs).toBe(2_000);
  });

  it('a non-429 4xx (403) is STILL terminal — fails fast, no retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(403, { code: 'RBAC_FORBIDDEN', message: 'no access' }),
      );
    globalThis.fetch = fetchMock;

    const client = makeQueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ['projects', 'picker'],
      queryFn: fetchProjectsForPicker,
    });
    const result = await observeUntilSettled(observer);

    // Terminal: surfaces an error state, never retried (unchanged from before).
    expect(result.isError).toBe(true);
    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as ApiError).status).toBe(403);
    // Fetched exactly once — no backoff, no retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const state = client.getQueryState(['projects', 'picker']);
    expect(state?.status).toBe('error');

    client.clear();
  });
});
