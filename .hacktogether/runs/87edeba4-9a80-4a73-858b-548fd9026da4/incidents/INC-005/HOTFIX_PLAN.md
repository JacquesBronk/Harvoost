# INC-005 — HOTFIX_PLAN (decision-ready; gate (a) options for the orchestrator)

Scope: fix the over-aggressive rate limit so a single authed user navigating/refreshing normally does not trip `RATE_LIMITED`, scope the limit per authenticated principal, PRESERVE the 5/60s `auth` brute-force cap on login/callback (INC-003) and `/me`'s `@SkipThrottle({auth:true})`, and make transient 429s recover instead of hard-erroring. Do NOT touch `.github/` or the real-Entra OIDC path.

The four issue-suggested fixes are mapped below. **The root correction (see ROOT_CAUSE.md) is that the binding limit is the `auth` 5/60s bucket applying to ALL routes, not the `global` 300/60s bucket.** Fixes A and B are NECESSARY and tightly coupled; C is nice-to-have; D is necessary for acceptance criterion 4.

---

## Fix A (NECESSARY) — stop the `auth` 5/60s bucket from applying to non-auth routes; right-size/keep `global`
**Files:** `apps/api/src/app.module.ts:40-44` (throttler config), and EITHER `apps/api/src/auth/auth.controller.ts:56` (class `@Throttle`) depending on the option chosen.
**Problem:** `ThrottlerModule.forRoot([{chatbot 30},{auth 5},{global 300}])` makes all three buckets apply to every route; the smallest (`auth` 5/60s) binds everything except `/me`.

Options (put to the user at gate (a)):
- **A1 (recommended): make routes opt-IN to the `auth` bucket instead of opting out.** Keep `forRoot` declaring only the app-wide `global` bucket (sized per Fix B). Declare `auth` (5/60s) and `chatbot` (30/60s) as buckets that only apply where explicitly named via `@Throttle({auth:{...}})` / `@Throttle({chatbot:{...}})`. The class-level `@Throttle({auth:...})` already on `AuthController` (auth.controller.ts:56) keeps login/callback at 5/60s. `/me` keeps `@SkipThrottle({auth:true})` (harmless once auth is opt-in). NET: routine reads are governed only by `global`; brute-force protection on login/callback is preserved. This is the cleanest match to all five acceptance criteria.
  - Implementation note: in throttler v6, a named bucket listed in `forRoot` is global. To make `auth`/`chatbot` opt-in, EITHER (i) leave only `global` in `forRoot` and apply `auth`/`chatbot` purely via `@Throttle` decorators with inline `{ttl,limit}` (the decorator can define the bucket), OR (ii) keep them in `forRoot` but add `@SkipThrottle({auth:true, chatbot:true})` on a base/most controllers — option (i) is far less error-prone (no per-controller skip sprawl) and is recommended.
- **A2 (not recommended): keep all three global but reorder/resize so `auth` is not the smallest applied to reads.** Fragile — any small global bucket still caps everything; rejected.

Trade-off to surface: A1 means a brand-new non-auth route gets only the `global` cap by default (correct) and a developer must remember to add `@Throttle({auth})` to any NEW brute-forceable endpoint. Acceptable and documented.

---

## Fix B (NECESSARY) — per-principal `getTracker` (+ right-size the per-principal budget)
**Files:** new `apps/api/src/common/throttler/principal-throttler.guard.ts` (custom guard overriding `getTracker`), wired at `apps/api/src/app.module.ts:68` in place of stock `ThrottlerGuard`. Optionally `apps/api/src/main.ts` if `trust proxy` is needed for the IP fallback.
**Approach:** subclass `ThrottlerGuard` and override `getTracker(req)` to return the authenticated principal id when present, falling back to `req.ip` for unauthenticated routes (login/callback/idp-info). CONFIRMED req shape: `BearerAuthGuard` (apps/api/src/auth/bearer-auth.guard.ts:90,106) sets `req.user = { userId, email, roles }`, so the tracker is e.g. `` (req.user as {userId?:string})?.userId ? `user:${req.user.userId}` : `ip:${req.ip}` ``. Prefix the user/ip variants so principals and IPs cannot collide. This gives each signed-in user an independent budget so one user/tab cannot exhaust everyone behind a shared IP (acceptance criterion 2).
**Budget sizing (grounded in measured fan-out):** a page load is ~4-6 reads; an active session navigating + refreshing does dozens of reads/min. Recommend the per-principal `global` budget at **>= 600/60s** (10 req/s) — comfortably above realistic single-user fan-out incl. React-Query refetch-on-mount and dev Strict-Mode double-mounts, while still bounding abuse. Sub-option to surface: 300 vs 600 vs 1000 per-principal — recommend 600. (Because it is now PER USER, the absolute number can be lower than a shared-IP number would need to be.)
**Guard-ordering note:** the throttler guard must run AFTER the auth guard so `req.user` is populated for `getTracker`. Confirm `APP_GUARD` provider order in app.module.ts:64-68 puts `BearerAuthGuard` before the throttler guard (it currently does). For unauthenticated brute-force routes the IP fallback is correct and intended.

---

## Fix C (NICE-TO-HAVE) — reduce client fan-out
**Files:** `apps/web/src/components/TimerBar.tsx`, `StartTimerControl.tsx`, `NewEntryForm.tsx`, `apps/web/src/lib/query-client.ts` (staleTime/dedupe).
**Approach:** dedupe overlapping queries (e.g. `['projects','picker']` is fetched by both `StartTimerControl` and `NewEntryForm`; ensure one shared cache key + adequate `staleTime`), and raise `staleTime` on rarely-changing reads so navigation reuses cache instead of refetching. This lowers pressure but is NOT required once A+B land. Defer unless the user wants belt-and-suspenders. Do NOT wire the SSE EventSource as part of this hotfix (it would ADD throttler pressure, not reduce it).

---

## Fix D (NECESSARY for criterion 4) — generalize client 429 backoff + expose the Retry-After header
**Files:** `apps/web/src/lib/query-client.ts:12-18` (global `retry`/`retryDelay`), `apps/web/src/lib/api-client.ts:53-59` (`parseRetryAfterMs`), and `apps/api/src/main.ts:33-37` (CORS `exposedHeaders`).
**Approach:**
1. In `query-client.ts`, special-case 429: instead of treating all 4xx as terminal, allow a bounded retry (e.g. `failureCount < 3`) for `status === 429` with `retryDelay` honoring `ApiError.retryAfterMs ?? cappedExponential`. Keep other 4xx terminal. This mirrors the `useCurrentUser` logic in `auth.ts` and satisfies "a transient 429 backs off and recovers."
2. **Load-bearing:** the backend's 429 carries `Retry-After-auth` (seconds) on the wire, but CORS does NOT expose it, so the browser cannot read it (confirmed live). Add `exposedHeaders: ['Retry-After-auth', 'Retry-After-global', 'Retry-After']` (and `X-RateLimit-*` if desired) to the `cors` options in `main.ts`. Whichever bucket name the fix standardizes on (after Fix A, reads that 429 will carry `Retry-After-global`), `parseRetryAfterMs` (api-client.ts:54) must read that name AND it must be CORS-exposed. Update the header-name fallback list in `parseRetryAfterMs` accordingly.
   - Sub-option: once Fix A makes `global` the bucket that throttles reads, the read-429 header becomes `Retry-After-global`. Decide whether to (i) standardize `parseRetryAfterMs` to read `Retry-After-global` first, or (ii) keep the broad fallback (`Retry-After-auth ?? Retry-After-global ?? Retry-After`). Recommend (ii) — robust to bucket renames.

---

## Implementer partition & ownership
- **backend-dev** owns `apps/api/*`: Fix A (app.module.ts + auth.controller.ts), Fix B (new guard + app.module.ts + CORS exposedHeaders in main.ts), and the backend regression tests. The CORS change in main.ts is backend-dev's.
- **frontend-dev** owns `apps/web/*`: Fix D (query-client.ts, api-client.ts), and optional Fix C, plus the frontend regression test.
- **api-designer / openapi:** NOT required — no request/response schema changes; the 429 envelope and headers are unchanged in shape. `@harvoost/contract` (`tests/contract/src/contract.test.ts`) is NOT implicated (no OpenAPI surface change). Skip unless the team wants to document the rate-limit headers in the spec.

## Regression tests to add
- **Backend (vitest, extend `apps/api/test/unit/throttler.test.ts`):**
  - Assert non-auth read routes (e.g. `ProjectsController.list`, `TimeEntriesController.running`) are NOT subject to the `auth` bucket after Fix A (no `auth` limiter metadata applies; or, post-A1, that `forRoot` declares only `global`). This is the exact regression that bit here.
  - Assert `oidcLogin`/`oidcCallback` still carry the 5/60s `auth` bucket (criterion 3 preserved) and `/me` still `@SkipThrottle({auth:true})`.
- **Backend integration/live (extend `tests/e2e/specs/throttle.spec.ts` or a new INC-005 spec, live-gated):**
  - Two principals behind one IP get INDEPENDENT budgets (drive two sessions; user A drains a route; user B's reads of that route still 200) — proves Fix B.
  - Auth 5/60s on login/callback preserved (6th login POST → 429).
- **Frontend (extend hermetic `auth.spec.ts`/a new spec, mock-api):**
  - A non-`/me` query (e.g. `['projects','picker']`) that receives a 429 with a Retry-After hint backs off and RECOVERS to a rendered panel (not a stuck error state) once the next response is 200 — proves Fix D.

## Rollback
Each fix is independently revertible:
- Fix A/B: revert `apps/api/src/app.module.ts` to the 3-bucket `forRoot` + stock `ThrottlerGuard`, delete the new principal guard, revert `main.ts` CORS `exposedHeaders`, revert any `@Throttle` decorator changes in `auth.controller.ts`. `git revert <hotfix-commit>` restores the prior throttler behavior.
- Fix D: revert `apps/web/src/lib/query-client.ts` and `api-client.ts` to terminal-4xx behavior.
No DB migrations, no schema/contract changes — rollback is code-only and safe.
