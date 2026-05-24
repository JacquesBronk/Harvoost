import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client.js';

// INC-005: the global query retry policy. A transient 429 (the throttler's
// "back off, try again" signal) must BACK OFF and RECOVER rather than render a
// hard error across the app — mirroring the per-query `useCurrentUser`/`auth.ts`
// backoff that #3 introduced for `/me`. Every OTHER 4xx stays terminal (it will
// not resolve on retry), so only 429 becomes retryable.
const MAX_429_RETRIES = 3;
// Cap so a slow self-heal can never hang the UI for long when the throttler
// gives us no usable `Retry-After-*` hint.
const MAX_BACKOFF_MS = 5_000;

/**
 * INC-005: global retry predicate. Retry a transient 429 with bounded attempts;
 * keep every other 4xx terminal (no retry); for 5xx / network (ApiError status
 * 0 or non-ApiError) fall back to the prior small bounded retry.
 */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError) {
    // 429 is the throttler asking us to back off — bounded retry so a brief
    // rate-limit window self-heals instead of leaving panels stuck in error.
    if (err.status === 429) {
      return failureCount < MAX_429_RETRIES;
    }
    // Every other 4xx is terminal — it won't resolve on retry (auth, validation,
    // not-found, forbidden). Preserves the pre-INC-005 behavior exactly.
    if (err.status >= 400 && err.status < 500) {
      return false;
    }
  }
  // 5xx / network / unknown: the prior small bounded retry.
  return failureCount < 2;
}

/**
 * INC-005: global retry delay (ms). Honor the throttler's `Retry-After-*` hint
 * (plumbed through ApiError.retryAfterMs) when present, otherwise capped
 * exponential backoff so the UI never hangs.
 */
export function queryRetryDelay(failureCount: number, err: unknown): number {
  const ra = err instanceof ApiError ? err.retryAfterMs : undefined;
  if (ra != null) return Math.min(ra, MAX_BACKOFF_MS);
  return Math.min(1000 * 2 ** failureCount, MAX_BACKOFF_MS);
}

// One QueryClient per browser tab. Strict-mode-safe via lazy init in the provider.
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
