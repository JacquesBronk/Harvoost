---
phase: hotfix INC-005 (GitHub #8)
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Implemented Fix D (frontend half) so a transient 429 BACKS OFF and RECOVERS
instead of rendering a hard error across the app. The global React-Query `retry`
predicate previously treated ANY 4xx (incl. 429) as terminal, so a single
throttled read left its panel stuck in an error state — only `useCurrentUser`
(`/me`, INC-003) honored the `Retry-After`-aware backoff. This change generalizes
that backoff to the global query client: 429 becomes a BOUNDED retry honoring the
throttler's hint, every OTHER 4xx stays terminal exactly as before, and the
shared `parseRetryAfterMs` now reads the read-429 header (`Retry-After-global`)
that the backend lane is CORS-exposing. Scoped to `apps/web/*` only; no
`apps/api/*`, `.github/`, or OIDC changes.

# Files touched
- apps/web/src/lib/query-client.ts (modified) — extracted two named, hermetically
  testable functions and wired them into `makeQueryClient`:
  - `shouldRetryQuery(failureCount, err)`: 429 → bounded retry (`failureCount < 3`);
    every other 4xx → terminal (no retry, unchanged from before); 5xx/network →
    the prior small bounded retry (`< 2`).
  - `queryRetryDelay(failureCount, err)`: `Math.min(err.retryAfterMs ?? cappedExponential, 5_000)`.
    Honors the throttler's `Retry-After-*` hint when present; capped exponential
    backoff (1s → 2s → 4s …, hard-capped at 5s) otherwise so the UI never hangs.
- apps/web/src/lib/api-client.ts (modified) — `parseRetryAfterMs` header fallback
  order is now `Retry-After-global ?? Retry-After-auth ?? Retry-After` (broad
  fallback, robust to bucket renames). Updated the three related doc comments
  (the `ApiError.retryAfterMs` field, the 429-capture site, and the function) to
  reflect that reads carry `Retry-After-global` and login/callback carry
  `Retry-After-auth`.
- apps/web/__tests__/inc005-query-429-backoff.test.ts (new) — 12-test hermetic
  regression (vitest, node env, mocked fetch, no live backend), patterned on
  INC-003's auth-me-loop.test.ts.

# Retry / backoff policy implemented (exact)
- 429 (any query): retry while `failureCount < 3`; delay = `min(retryAfterMs ?? 1000*2**n, 5000)`.
- Other 4xx (400/401/403/404/409/422 …): terminal — no retry (unchanged).
- 5xx / network (ApiError status 0) / unknown: retry while `failureCount < 2`
  (the prior pre-INC-005 behavior, preserved).
- Mutations: still `retry: false` (untouched).

# What downstream agents need to know
- DECISION (header fallback): chose the broad fallback list
  `Retry-After-global ?? Retry-After-auth ?? Retry-After` (HOTFIX_PLAN Fix D
  sub-option (ii)) rather than standardizing on a single name — robust to bucket
  renames and keeps the INC-003 `/me` (`Retry-After-auth`) path correct. This is
  load-bearing on the backend lane CORS-exposing all three headers (pinned
  contract). If the backend exposes only `Retry-After-global`, reads still work;
  `Retry-After-auth` remains needed for the login/callback 429 path.
- DECISION (backoff cap): capped both the hint-honored delay and the exponential
  fallback at 5s (vs. `useCurrentUser`'s 30s) so a throttle self-heal never
  visibly hangs a data panel. Bounded at 3 retries for 429.
- INC-003 NOT regressed: `useCurrentUser`/`auth.ts` keep their own
  `shouldRetryAuth`/`authRetryDelay` (untouched); they consume the same
  `parseRetryAfterMs`, and the auth-me-loop suite (incl. its `Retry-After-auth`
  assertions) still passes 20/20.
- Fix C (client fan-out / staleTime / dedupe) was DEFERRED per dispatch — not done.

# Open questions / unknowns
- None. The fix depends on the backend lane CORS-exposing `Retry-After-global`
  (pinned cross-lane contract); the frontend half is complete and self-heals once
  that header is readable in the browser.

# Verification evidence
- `pnpm --filter @harvoost/web test` → 87 passed (8 files). Baseline was 75; +12
  new INC-005 tests. No failures, no unhandled rejections.
- `pnpm --filter @harvoost/web typecheck` (`tsc --noEmit`) → clean, no errors.
- New test proves: a `['projects','picker']` read that 429s (with
  `Retry-After-global: 2`) then 200s recovers to rendered data via a real
  `QueryObserver` (success state, 2 fetches, no storm); the parsed `retryAfterMs`
  is read off the exposed header (2000ms); and a 403 is still terminal (error
  state, fetched exactly once).
