import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, parseRetryAfterMs } from '../src/lib/api-client.js';
import {
  authRetryDelay,
  fetchCurrentUser,
  resolveAuthGate,
  shouldRetryAuth,
  type CurrentUser,
} from '../src/lib/auth.js';

/**
 * INC-003 regression — the authenticated `/me` request loop that tripped the
 * 5/60s brute-force throttle and wedged the app on "Loading Harvoost".
 *
 * Frontend (the amplifier): `useCurrentUser` mapped ONLY 401/403 to `null` and
 * RE-THREW everything else with `retry: false`; downstream consumers treated
 * the resulting `undefined` user as "logged out" → redirect → remount →
 * refetch (no backoff) → 900-request storm.
 *
 * These tests pin the fix without rendering React (node env, the existing
 * apps/web/__tests__ convention):
 *   1. fetchCurrentUser returns `null` ONLY for 401/403; a 429/5xx/network
 *      RE-THROWS so the query is a transient error (data stays undefined).
 *   2. ApiError carries the throttler's `Retry-After-auth` hint as retryAfterMs,
 *      and the backoff honors it.
 *   3. shouldRetryAuth never retries 401/403, but does retry 429/5xx/network
 *      with bounded attempts.
 *   4. resolveAuthGate (the shared redirect rule) never sends to /login on a
 *      transient error — only on a genuine `null`.
 */

const ALICE: CurrentUser = {
  id: 'usr_alice',
  email: 'alice@harvoost.test',
  display_name: 'Alice Example',
  timezone: 'Africa/Johannesburg',
  roles: ['employee'],
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

describe('parseRetryAfterMs (INC-003 throttler hint)', () => {
  it('reads the named `Retry-After-auth` header (seconds) and returns ms', () => {
    const headers = new Headers({ 'Retry-After-auth': '54' });
    expect(parseRetryAfterMs(headers)).toBe(54_000);
  });

  it('falls back to a plain `Retry-After` when the named header is absent', () => {
    const headers = new Headers({ 'Retry-After': '12' });
    expect(parseRetryAfterMs(headers)).toBe(12_000);
  });

  it('prefers `Retry-After-auth` over a plain `Retry-After`', () => {
    const headers = new Headers({ 'Retry-After-auth': '54', 'Retry-After': '1' });
    expect(parseRetryAfterMs(headers)).toBe(54_000);
  });

  it('returns undefined when neither header is present or value is unusable', () => {
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'Retry-After-auth': 'soon' }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'Retry-After-auth': '-5' }))).toBeUndefined();
  });
});

describe('fetchCurrentUser (INC-003: only 401/403 → null)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the user on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, ALICE));
    await expect(fetchCurrentUser()).resolves.toEqual(ALICE);
  });

  it('maps 401 → null (genuinely unauthenticated)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { code: 'UNAUTHORIZED', message: 'no' }));
    await expect(fetchCurrentUser()).resolves.toBeNull();
  });

  it('maps 403 → null (genuinely unauthenticated)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { code: 'FORBIDDEN', message: 'no' }));
    await expect(fetchCurrentUser()).resolves.toBeNull();
  });

  it('RE-THROWS a 429 (transient) — must NOT become null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        { code: 'RATE_LIMITED', message: 'ThrottlerException: Too Many Requests' },
        { 'Retry-After-auth': '54' },
      ),
    );
    const err = await fetchCurrentUser().then(
      (v) => ({ resolved: v }),
      (e) => ({ thrown: e }),
    );
    expect('thrown' in err).toBe(true);
    const thrown = (err as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(429);
    // Crucial: a transient 429 is NEVER swallowed into a fake "logged out" null.
    expect('resolved' in err).toBe(false);
  });

  it('a 429 ApiError carries the Retry-After-auth hint as retryAfterMs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        { code: 'RATE_LIMITED', message: 'Too Many Requests' },
        { 'Retry-After-auth': '54' },
      ),
    );
    const thrown = await fetchCurrentUser().catch((e) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).retryAfterMs).toBe(54_000);
  });

  it('RE-THROWS a 5xx (transient) — must NOT become null', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { code: 'UNAVAILABLE', message: 'down' }));
    const thrown = await fetchCurrentUser().catch((e) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(503);
  });

  it('RE-THROWS a network failure as ApiError status 0 — must NOT become null', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const thrown = await fetchCurrentUser().catch((e) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(0);
  });
});

describe('shouldRetryAuth (INC-003 backoff predicate)', () => {
  it('never retries a genuine 401/403', () => {
    const e401 = new ApiError(401, { code: 'UNAUTHORIZED', message: '' });
    const e403 = new ApiError(403, { code: 'FORBIDDEN', message: '' });
    expect(shouldRetryAuth(0, e401)).toBe(false);
    expect(shouldRetryAuth(0, e403)).toBe(false);
  });

  it('retries 429 / 5xx / network with bounded attempts', () => {
    const e429 = new ApiError(429, { code: 'RATE_LIMITED', message: '' });
    const e503 = new ApiError(503, { code: 'UNAVAILABLE', message: '' });
    const eNet = new ApiError(0, { code: 'NETWORK_ERROR', message: '' });
    for (const err of [e429, e503, eNet]) {
      expect(shouldRetryAuth(0, err)).toBe(true);
      expect(shouldRetryAuth(3, err)).toBe(true);
      // Bounded: stops after 4 attempts so we never storm.
      expect(shouldRetryAuth(4, err)).toBe(false);
    }
  });
});

describe('authRetryDelay (INC-003 backoff timing)', () => {
  it('honors the throttler hint (retryAfterMs) when present', () => {
    const e429 = new ApiError(
      429,
      { code: 'RATE_LIMITED', message: '' },
      { retryAfterMs: 54_000 },
    );
    expect(authRetryDelay(0, e429)).toBe(54_000);
    expect(authRetryDelay(2, e429)).toBe(54_000);
  });

  it('falls back to capped exponential backoff when no hint', () => {
    const eNet = new ApiError(0, { code: 'NETWORK_ERROR', message: '' });
    expect(authRetryDelay(0, eNet)).toBe(1000);
    expect(authRetryDelay(1, eNet)).toBe(2000);
    expect(authRetryDelay(2, eNet)).toBe(4000);
    // Capped at 30s so it can never run away.
    expect(authRetryDelay(10, eNet)).toBe(30_000);
  });
});

describe('resolveAuthGate (INC-003: redirect ONLY on genuine null)', () => {
  it('waits (no navigation) while loading', () => {
    expect(
      resolveAuthGate({ user: undefined, isLoading: true, isError: false }),
    ).toEqual({ kind: 'wait' });
  });

  it('waits (no navigation) on a transient error — NOT logged out', () => {
    // This is the INC-003 fix: a 429/5xx/network error leaves user === undefined
    // and isError === true. The gate must say "wait", never "login".
    const decision = resolveAuthGate({
      user: undefined,
      isLoading: false,
      isError: true,
    });
    expect(decision).toEqual({ kind: 'wait' });
    expect(decision.kind).not.toBe('login');
  });

  it('redirects to /login ONLY when user is genuinely null', () => {
    expect(
      resolveAuthGate({ user: null, isLoading: false, isError: false }),
    ).toEqual({ kind: 'login' });
  });

  it('resolves the authed user on a successful load', () => {
    expect(
      resolveAuthGate({ user: ALICE, isLoading: false, isError: false }),
    ).toEqual({ kind: 'authed', user: ALICE });
  });

  it('waits if user is undefined with no flags set (still settling)', () => {
    expect(
      resolveAuthGate({ user: undefined, isLoading: false, isError: false }),
    ).toEqual({ kind: 'wait' });
  });
});
