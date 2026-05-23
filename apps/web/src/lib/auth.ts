'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from './api-client.js';

// Shape returned by GET /v1/auth/me.
// Keep this loose until we wire openapi-typescript-generated types.
export interface CurrentUser {
  id: string;
  email: string;
  // INC-002: GET /v1/auth/me returns a guaranteed non-empty display name.
  display_name: string;
  timezone: string;
  roles: Array<'admin' | 'finmgr' | 'manager' | 'employee'>;
  scope_summary?: {
    visible_users_count: number; // -1 = unrestricted
    visible_projects_count: number; // -1 = unrestricted
  };
}

/**
 * INC-003: queryFn for the shared ['auth','me'] observer.
 *
 * Maps ONLY 401/403 to `null` ("genuinely unauthenticated"). Every other error
 * — 429 (throttled), 5xx, or network (ApiError status 0) — is RE-THROWN so the
 * query enters a TRANSIENT error state (`isError === true`, `data === undefined`,
 * never `null`). Consumers must treat `undefined`/`isError` as "still resolving"
 * and treat ONLY `null` as logged-out, otherwise a single transient 429 cascades
 * into a redirect → remount → refetch storm (the INC-003 bug).
 */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    return await apiFetch<CurrentUser>('/v1/auth/me');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}

/**
 * INC-003: retry predicate for the auth query. Never retry a genuine 401/403
 * (it will not resolve on retry — the user is logged out); for everything else
 * (429 / 5xx / network) retry with bounded exponential backoff.
 */
export function shouldRetryAuth(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return false;
  }
  return failureCount < 4;
}

/**
 * INC-003: backoff delay (ms). Honor the throttler's `Retry-After-auth` hint if
 * present (plumbed through ApiError.retryAfterMs), otherwise capped exponential
 * backoff.
 */
export function authRetryDelay(failureCount: number, err: unknown): number {
  const ra = err instanceof ApiError ? err.retryAfterMs : undefined;
  return ra ?? Math.min(1000 * 2 ** failureCount, 30_000);
}

export function useCurrentUser() {
  return useQuery<CurrentUser | null>({
    queryKey: ['auth', 'me'],
    queryFn: fetchCurrentUser,
    staleTime: 60_000,
    // INC-003: retry transient failures (429/5xx/network) with backoff; never
    // retry 401/403. retry: false previously meant a single 429 stuck the query
    // in error state with no recovery.
    retry: shouldRetryAuth,
    retryDelay: authRetryDelay,
  });
}

/**
 * INC-003: the single source of truth for "where should the auth gate send the
 * user". Extracted as a pure function so the redirect rule is testable without
 * rendering and shared between the home page and the AppShell.
 *
 * The cardinal rule: redirect to /login ONLY when the user is genuinely `null`
 * (a 401/403 mapped by fetchCurrentUser). While loading OR in a transient error
 * state, we are "still resolving" — keep the user on the spinner and let the
 * query's backoff recover. Redirecting on transient error is what created the
 * INC-003 redirect → remount → refetch storm.
 */
export type AuthGateState = {
  user: CurrentUser | null | undefined;
  isLoading: boolean;
  isError: boolean;
};

export type AuthGateDecision =
  | { kind: 'wait' } // loading or transient error — show spinner, do not navigate
  | { kind: 'login' } // genuinely unauthenticated — redirect to /login
  | { kind: 'authed'; user: CurrentUser }; // resolved user

export function resolveAuthGate(state: AuthGateState): AuthGateDecision {
  if (state.isLoading || state.isError) return { kind: 'wait' };
  if (state.user === null) return { kind: 'login' };
  if (state.user) return { kind: 'authed', user: state.user };
  // user === undefined with no loading/error flag: still settling — wait.
  return { kind: 'wait' };
}

export function hasRole(
  user: CurrentUser | null | undefined,
  ...roles: CurrentUser['roles']
): boolean {
  if (!user) return false;
  return roles.some((r) => user.roles.includes(r));
}

export function isAdmin(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin');
}

export function isFinMgr(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'finmgr');
}

export function isManager(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'manager');
}

export function canSeeFinancialData(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin', 'finmgr');
}

export function canApproveStage1(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin', 'manager');
}

export function canApproveStage2(user: CurrentUser | null | undefined): boolean {
  return hasRole(user, 'admin', 'finmgr');
}
