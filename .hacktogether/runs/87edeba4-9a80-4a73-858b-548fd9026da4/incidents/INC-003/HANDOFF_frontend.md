---
phase: 04-build/frontend
agent: frontend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Fixed the frontend half (Lane A — "the amplifier") of INC-003: the authenticated
`/me` request storm that wedged the app on "Loading Harvoost". `useCurrentUser`
previously mapped only 401/403 to `null` and re-threw everything else with
`retry: false`; downstream consumers (home page, AppShell, guards) treated the
resulting `undefined` user as "logged out" → redirect to `/login` → remount →
fresh refetch with no backoff → 900-request loop on a single backend 429. The
fix: a transient 429/5xx/network error now stays a TRANSIENT query error
(`isError`, `data === undefined`, never `null`) with bounded exponential backoff
that honors the throttler's `Retry-After-auth` hint, and the redirect/shell rule
was centralized so it sends to `/login` ONLY on a genuine `null`. Login/callback
semantics and the real-Entra OIDC path are untouched.

# Files touched
- apps/web/src/lib/api-client.ts (modified) — added `retryAfterMs?: number` to
  `ApiError` (+ optional 3rd ctor arg); added exported `parseRetryAfterMs(headers)`
  that reads `Retry-After-auth` (seconds) first, falls back to plain `Retry-After`,
  returns ms; wired it into the non-2xx `ApiError` construction for `status === 429`.
- apps/web/src/lib/auth.ts (modified) — extracted `fetchCurrentUser` (only 401/403
  → null, else re-throw), `shouldRetryAuth` (no retry on 401/403, else `count < 4`),
  `authRetryDelay` (honors `retryAfterMs`, else capped exp backoff to 30s); rewired
  `useCurrentUser` to use them (replacing `retry: false`); added the pure
  `resolveAuthGate(state)` helper (+ `AuthGateState`/`AuthGateDecision` types) as the
  single source of truth for the redirect rule.
- apps/web/app/page.tsx (modified) — home redirect now uses `resolveAuthGate`; pulls
  `isError`; `wait` (loading OR transient) → stay on spinner, `login` → `/login`,
  `authed` → `/timesheets`. Never redirects on transient error.
- apps/web/src/components/AppShell.tsx (modified) — pulls `isError`; uses
  `resolveAuthGate`; `wait` → spinner (was: only `isLoading`), `login` → bare
  children, `authed` → shell. References to `user` in the shell body switched to the
  narrowed `currentUser` from the decision.
- apps/web/__tests__/auth-me-loop.test.ts (new) — 20 regression tests (see below).

# What downstream agents need to know
- The redirect rule is now centralized in `resolveAuthGate` in `apps/web/src/lib/auth.ts`.
  Any future auth gate should branch on its `{ kind: 'wait' | 'login' | 'authed' }`
  decision rather than re-deriving "falsy user means logged out". Convention to enforce:
  redirect-to-`/login` ONLY on `data === null`, never on `isError`/`undefined`.
- Guards audited and intentionally left unchanged (they already follow the rule):
  - `src/lib/rbac.ts useScope` — derives UI flags off `!!user`; no navigation. Correct.
  - `app/timesheets|dashboard|schedule|settings/page.tsx` — gate data queries via
    `enabled: !!user` and never redirect to `/login`. They are wrapped by the
    `AppShell` layout, which now shows the spinner during transient error so their
    bodies never render in that state.
  - RBAC redirects in `app/admin/*`, `app/financial`, `app/approvals/final`,
    `app/leave/approvals` redirect to `/timesheets` (NOT `/login`) and only fire when
    `scope.user` is truthy AND a role check fails — they cannot fire on a transient
    error (user is `undefined`/falsy then) and are not part of the auth storm.
- `app/auth/callback/page.tsx` — NOT touched (per plan #6). Its `oidc/callback` error
  → `/login` is intentional; a real brute-force 429 on the callback POST should still
  send to `/login`.
- Confirmed a SINGLE `QueryClientProvider` at the root (`src/components/Providers.tsx`,
  lazy `makeQueryClient`), so the `['auth','me']` observer is deduped by key — no
  second provider added. The loop came from remounts (now removed by the redirect fix),
  not duplicate hooks.
- `apps/web/src/lib/query-client.ts` default `retry` returns `false` for 4xx, but the
  per-query `retry`/`retryDelay` on `useCurrentUser` override it, so the 429-with-backoff
  behavior applies specifically to `/me` while other queries keep the conservative default.
- OUT OF SCOPE (noticed, no change made, per constraints): issue #4 reporting-endpoint
  mismatches and issue #5 timesheets timer were not touched.
- Backend Lane B (taking `/me` off the `auth` bucket) is still required — this lane only
  removes the amplification; both lanes are needed per the plan.

# Open questions / unknowns
- `pnpm --filter @harvoost/web lint` fails with a pre-existing ESLint/`next lint`
  options-incompatibility ("Unknown options: useEslintrc, extensions, ...") that errors
  before any file is linted — unrelated to this change and out of scope for INC-003.
  Typecheck and vitest (the task's verification gates) are both green.

# Verification evidence
- `pnpm --filter @harvoost/web typecheck` (`tsc --noEmit`) → PASS, no errors.
- `pnpm --filter @harvoost/web test` (`vitest run`) → PASS, 41/41 across 4 files:
  `__tests__/auth-me-loop.test.ts` (20 new), `__tests__/middleware.test.ts` (7,
  INC-001), `__tests__/avatar.test.ts` (9, INC-002), `src/lib/idp-info.test.ts` (5) —
  no pre-existing tests broken.
- New tests assert: `parseRetryAfterMs` prefers `Retry-After-auth` (54 → 54000ms),
  falls back to `Retry-After`, returns undefined for missing/garbage/negative;
  `fetchCurrentUser` → user on 200, `null` on 401/403, RE-THROWS (data stays undefined,
  never null) on 429/5xx/network and the 429 `ApiError.retryAfterMs === 54000`;
  `shouldRetryAuth` false for 401/403, true-then-bounded for 429/5xx/network;
  `authRetryDelay` honors the 54s hint else capped exp backoff (1s/2s/4s…30s cap);
  `resolveAuthGate` returns `wait` on loading AND on transient error (never `login`),
  `login` ONLY on `null`, `authed` on a user.
- Login/callback flow + real-Entra OIDC path: untouched (`auth/callback/page.tsx`,
  `lib/oidc.ts`, login leg, env, middleware all unmodified).
