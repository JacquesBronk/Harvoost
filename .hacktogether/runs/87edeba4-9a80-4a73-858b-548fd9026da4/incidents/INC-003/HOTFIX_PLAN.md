# INC-003 — HOTFIX_PLAN (GitHub issue #3)

Two independent fix lanes; **both required** (either alone is insufficient). Recommended
implementer agents: **backend-dev** (lane B) and **frontend-dev** (lane A) — can run in parallel.
The debugger does NOT implement these.

## Files Changed

### Lane B — Backend (implementer: backend-dev)
- `apps/api/src/auth/auth.controller.ts` — take **`/me` off the brute-force `auth` bucket**.
  Keep the class-level `@Throttle({ auth: { ttl: 60_000, limit: 5 } })` (line 56) so
  `oidc/login` + `oidc/callback` retain brute-force protection, and **override only `me()`**
  (the `@Get('me')` method at line 334) so it falls back to the global 300/60s bucket:
  ```ts
  import { SkipThrottle } from '@nestjs/throttler';
  // ...
  @SkipThrottle({ auth: true })   // <-- add directly above @Get('me')
  @Get('me')
  async me(...) { ... }
  ```
  `@SkipThrottle({ auth: true })` skips ONLY the named `auth` bucket; the global 300/60s bucket
  still applies (verified present: `app.module.ts:41` `{ name: 'global', ttl: 60_000, limit: 300 }`).
  Acceptable alternative: a method-level `@Throttle({ auth: { ttl: 60_000, limit: 300 } })` override.
  Prefer `@SkipThrottle` — it is the clearest statement of intent ("/me is not brute-forceable").
  **DO NOT weaken `oidc/login` / `oidc/callback`** — they MUST stay at 5/60s.
- `apps/api/src/app.module.ts` — no change required (bucket definitions are correct; lines 38–42).

### Lane A — Frontend (implementer: frontend-dev)
- `apps/web/src/lib/auth.ts` — in `useCurrentUser` (lines 21–37):
  - Keep mapping **401/403 → `null`** ("genuinely unauthenticated", line 28).
  - For **429 / 5xx / network (ApiError status 0)**: do **NOT** return `null` and do **NOT**
    swallow — let it become a TRANSIENT query error so consumers see `isError` (not a fake
    "logged out"). Re-throw (current line 31 behavior) is correct ONLY once consumers stop
    treating `undefined` as logged-out (see page.tsx/guards below).
  - Replace `retry: false` (line 35) with bounded **exponential backoff that retries 429/5xx/network**
    but NOT 401/403:
    ```ts
    retry: (count, err) =>
      err instanceof ApiError && (err.status === 401 || err.status === 403)
        ? false
        : count < 4,
    retryDelay: (count, err) => {
      // Honor the throttler's per-bucket header. NOTE: it is `Retry-After-auth`,
      // NOT a plain `Retry-After` (confirmed live). Plumb it through ApiError if
      // available; otherwise fall back to capped exponential backoff.
      const ra = err instanceof ApiError ? err.retryAfterMs : undefined;
      return ra ?? Math.min(1000 * 2 ** count, 30_000);
    },
    ```
  - Ensure a **single shared `['auth','me']` observer** (React Query already dedupes by key;
    the loop came from REMOUNTS, not duplicate hooks — fixing the redirect below removes the
    remount). No extra QueryClient changes needed beyond confirming one provider at the root.
- `apps/web/src/lib/api-client.ts` — when building `ApiError` for a 429 (lines 112–121), capture
  the retry hint so the frontend can honor it: read header **`Retry-After-auth`** (seconds),
  fall back to plain `Retry-After`, expose as `ApiError.retryAfterMs`. (Live header observed:
  `Retry-After-auth: 54`; no plain `Retry-After`.)
- `apps/web/app/page.tsx` (lines 12–19) — redirect to `/login` **ONLY when `data === null`**
  (genuine 401/403). While `isLoading` OR `isError` (transient), keep showing the spinner /
  a retry state — never redirect. e.g.:
  ```ts
  if (isLoading || isError) return; // stay on spinner; do not redirect
  if (user === null) router.replace('/login');
  else if (user) router.replace('/timesheets');
  ```
- `apps/web/src/components/AppShell.tsx` (lines 88–101) — same rule: treat `isError`/undefined
  as "still resolving / transient", not "logged out". Only `user === null` should drop the shell.
  Pull `isError` out of `useCurrentUser()` alongside `isLoading`.
- `apps/web/app/auth/callback/page.tsx` — no required change for #3 (the callback path 429 is
  fixed by lane B taking `/me` off the bucket + lane A not redirecting on transient error).
  Optional hardening: the `oidc/callback` POST itself can still legitimately 429 under brute
  force — leave its error → `/login` (line 58), that is correct.
- Other guards keyed off `useCurrentUser().data` (`timesheets/page.tsx`, `dashboard/page.tsx`,
  `schedule/page.tsx`, `settings/page.tsx`, `src/lib/rbac.ts`) — audit each so they branch on
  `data === null` (logged out) vs `isError`/`isLoading` (transient/loading), never redirecting on
  the latter.

## Tests to add (regression — acceptance criterion 4)
- **Backend (unit/e2e):** authenticated `/me` is NOT on the 5/60s `auth` bucket — fire >5 rapid
  authenticated `/me` calls and assert no 429; separately assert `oidc/login` still 429s after 5/60s.
- **Frontend (unit):** `useCurrentUser` returns `null` ONLY for 401/403; for a 429/5xx/network it
  surfaces `isError` (data stays `undefined`, never `null`) and does not trigger a redirect.
- **Frontend (e2e):** a stubbed transient 429 on `/me` → app stays on spinner, backs off, recovers
  on the next 200; assert it does NOT navigate to `/login` and does NOT emit a burst of `/me` calls.

## Rollback
Both lanes are additive and isolated. To revert:
- Lane B: remove the `@SkipThrottle({ auth: true })` (or method `@Throttle`) line above `me()` in
  `apps/api/src/auth/auth.controller.ts` and drop the `SkipThrottle` import. Restores prior behavior.
- Lane A: `git revert` the frontend commit (changes confined to `auth.ts`, `api-client.ts`,
  `page.tsx`, `AppShell.tsx`, and any guard files touched). No schema/migration/config changes,
  so revert is clean and immediate.
