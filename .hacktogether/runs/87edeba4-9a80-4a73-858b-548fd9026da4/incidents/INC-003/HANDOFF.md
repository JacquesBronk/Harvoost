---
phase: INC-003 (debugger — reproduce + confirm)
agent: debugger
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Reproduced GitHub issue #3 in a real browser (Playwright `chromium-live`, full Keycloak
sign-in as Alice against the running stack) and CONFIRMED — not revised — the pre-diagnosed
two-defect root cause. A single authenticated session fired **909 `GET /v1/auth/me` requests
in 11.4s** (4× 200, then **905× 429 RATE_LIMITED**); the **5th `/me` request was the first 429**,
and the storm ran with **no backoff** until the app wedged on the "Loading Harvoost" spinner.
Wrote `ROOT_CAUSE.md`, `HOTFIX_PLAN.md`, and the throwaway repro under `repro/`. Did NOT
implement the fix and did NOT touch `apps/api` / `apps/web` source, `.github/`, or the realm.

# Files touched (all under the incident folder — no product source changed)
- `incidents/INC-003/ROOT_CAUSE.md` (new)
- `incidents/INC-003/HOTFIX_PLAN.md` (new)
- `incidents/INC-003/HANDOFF.md` (new)
- `incidents/INC-003/repro/auth-me-loop.repro.spec.ts` (new — throwaway live repro)
- `incidents/INC-003/repro/playwright.repro.config.ts` (new — throwaway config, mirrors chromium-live)
- `incidents/INC-003/repro/run-3.log` + `run-3.trimmed.log` (new — captured network timeline)

# What downstream agents need to know
- **CONFIRMED both defects.** B (backend): class-level `@Throttle({auth:5/60s})` at
  `auth.controller.ts:56` covers `@Get('me')` (line 334), sharing the bucket with login+callback
  (`app.module.ts:40`). A (frontend): `useCurrentUser` (`auth.ts:28-31`) maps only 401/403→null,
  re-throws 429/5xx/network with `retry:false`; `page.tsx:14-18` + `AppShell.tsx:98` + page guards
  redirect/teardown on falsy user → remount → refetch storm.
- **NEW finding for the fix:** the 429 carries header **`Retry-After-auth: 54`** (NestJS per-named
  bucket), **NOT a plain `Retry-After`**. The frontend backoff must read `Retry-After-auth` (with a
  capped-exponential fallback). `ApiError` has no `retryAfterMs` field yet — needs adding in
  `api-client.ts`. This is reflected in HOTFIX_PLAN.
- **Bucket is per-IP and shared:** login + callback burn 2 of the 5 tokens on every fresh sign-in,
  so only ~3 `/me` calls remain before lockout — that is why the loop ignites almost immediately
  after sign-in, often bouncing straight to `/login` on the very first post-callback navigation.
- **Control proof:** 10 unauthenticated `/me` hits returned 401, never 429 — the auth guard
  short-circuits before the throttler counts, so the limit only bites authenticated sessions.
- **Recommended fix lanes (parallel):** backend-dev (lane B: `@SkipThrottle({auth:true})` on `me()`,
  keep 5/60s on login+callback) and frontend-dev (lane A: transient-error handling + backoff +
  redirect-only-on-`data===null`). Both required.
- **Test-pollution gotcha for whoever re-runs the live repro:** the shared `signInAs()` helper's
  `waitForURL(/timesheets/)` THROWS when the app bounces to `/login` (the bug). My repro inlines a
  resilient hand-driven login. Also: each run consumes the 5/60s bucket — wait ~62s for the window
  to clear before re-running, or the login POST itself 429s.

# Open questions / unknowns
- None blocking. The `Retry-After-auth` (vs plain `Retry-After`) header detail is the only nuance
  the frontend implementer must not miss; it is called out in HOTFIX_PLAN lane A.

# Verification evidence
- `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 playwright test --config .../repro/playwright.repro.config.ts`
  → 1 passed; **909 /me reqs / 11.4s, first 429 at request #5, 905 total 429, no backoff, app wedged
  on "Loading Harvoost"**. Full log: `repro/run-3.log`.
- `for i in 1..10; curl /v1/auth/me (unauth)` → 10× 401, 0× 429 (guard short-circuits throttler).
- `curl -D - POST /v1/auth/oidc/login ×N` → 429 body `{"code":"RATE_LIMITED",...}`, header
  `Retry-After-auth: 54` (no plain `Retry-After`).
