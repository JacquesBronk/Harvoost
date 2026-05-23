# Incident INC-003 — auth-me-request-loop-trips-throttle

GitHub issue: [#3](https://github.com/JacquesBronk/Harvoost/issues/3) — "Auth /me request loop trips the 5/60s 'auth' throttle → RATE_LIMITED makes the app unusable"
Follow-up to INC-002 (closed via commit 23f0311). The request loop became reachable only once the full Keycloak sign-in round-trip worked (INC-002).

## Reporter description (verbatim)
> After signing in (as Alice), navigating, and especially **refreshing** a page, the browser fires a burst of `GET /v1/auth/me` requests and the API starts returning `{"code":"RATE_LIMITED","message":"ThrottlerException: Too Many Requests"}`. "auth/me is getting ddosed … somewhere we have a loop killing us." Once tripped, the whole app is unusable until the 60s throttle window clears (every authenticated request shares the bucket).

## Triage (orchestrator — incident-responder skipped per user-directed hotfix flow, as in INC-001/INC-002)
- **Severity:** sev-2 — every authenticated dev/demo session becomes unusable within seconds of normal navigation; no production impact (prod OIDC path intentionally fail-closed, deferred to v0.2.0, and is untouched here).
- **Scope:** TWO compounding defects, both must be fixed (either alone is insufficient):
  - **A. Frontend** — `apps/web/src/lib/auth.ts` (`useCurrentUser`, ~lines 27-36) maps only 401/403 → `null`; a 429 (and 5xx/network) **re-throws** → query goes to error state, `data === undefined`. `apps/web/app/page.tsx` (~lines 12-19) and route guards treat absent user as "logged out" → `router.replace('/login')` → remount → `useCurrentUser` refetches `/me` with NO backoff → loop.
  - **B. Backend** — `apps/api/src/auth/auth.controller.ts:56` puts `@Throttle({ auth: { ttl: 60_000, limit: 5 } })` on the `@Controller` class, so it covers `@Get('me')` (line 334). The `auth` bucket is 5/60s (`apps/api/src/app.module.ts:38-41`), shared with login + callback. `/me` is hit on every page load, so it 429s almost instantly and ignites loop A. (Unauthenticated `/me` returns 401 *before* the throttler counts; only authenticated `/me` counts — that's why it only bites real sessions.)
- **Reproduction:** Sign in as `alice@harvoost.local` / `dev-alice-pass` → navigate to a couple of pages → hard-refresh several times within ~60s → burst of `GET /v1/auth/me` in the Network panel → `429 {"code":"RATE_LIMITED",...}`; UI shows "You are sending requests too quickly."
- **Blast radius:** every authenticated session, on normal navigation/refresh. Both layers compound: the backend 429 is the trigger, the frontend misclassification is the amplifier (turns one 429 into a storm).
- **Rollback recommended:** no — INC-001 + INC-002 fixes are correct and must stay; this is a forward fix on the throttle scope (backend) + 429 handling (frontend) only.

## Root cause — already diagnosed (debugger REPRODUCES + CONFIRMS, does NOT re-discover)
Both defects A and B above are pre-diagnosed in issue #3 with file:line evidence. The debugger's job is to **reproduce the loop in a real browser (Playwright `chromium-live` against the running stack) and confirm the diagnosis with live evidence** — not to re-derive it. Specifically confirm:
1. A real authenticated session, navigating + hard-refreshing within 60s, trips `RATE_LIMITED` on `/v1/auth/me` (defect B observable).
2. A 429 on `/me` drives a redirect to `/login` and a refetch storm with no backoff (defect A observable).

## Suggested fix (both layers — fix both)
- **Backend:** take `/me` off the brute-force bucket. Add `@SkipThrottle({ auth: true })` on the `me()` method (falls back to the global 300/60s bucket), OR a method-level `@Throttle` override. **KEEP 5/60s on `oidc/login` + `oidc/callback`** (brute-force protection — do not weaken it).
- **Frontend:** in `useCurrentUser`, treat 429/5xx/network as a **TRANSIENT error** — do NOT return `null` and do NOT let it drive the `/login` redirect. `page.tsx` (and any guard) must only redirect when `data === null` (genuine 401/403), never on an error/undefined state. Add retry with exponential backoff honoring `Retry-After` for 429. Ensure a single shared `['auth','me']` observer (no remount storm).

## Acceptance criteria (from issue)
1. A real authenticated session can navigate + refresh freely without tripping `RATE_LIMITED` on `/v1/auth/me`.
2. A transient 429 (or 5xx/network) on `/me` does **not** redirect to `/login` and does **not** produce a request storm; it backs off and recovers.
3. `login`/`callback` keep their 5/60s brute-force protection.
4. Regression coverage (unit/e2e): authenticated `/me` not on the 5/60s bucket; `useCurrentUser` does not loop/redirect on 429.
5. `pnpm test` stays green (baseline 404 pass + 1 known pre-existing `RbacScopeService` failure).
6. CHANGELOG `[Unreleased] / Fixed` entry referencing #3.

## Scope guardrails
- Do NOT touch the real-Entra-in-prod OIDC path (fail-closed, v0.2.0).
- Do NOT weaken `login`/`callback` throttling.
- Do NOT touch `.github/` (still needs the `workflow` OAuth scope; leave untracked, as in INC-001/INC-002).
- Stay scoped to #3 — the data-loading endpoint mismatches (#4) and the timesheets timer gap (#5) are SEPARATE issues; do not fix them here.
- GOTCHA: `docker compose down` does NOT re-import `infra/keycloak/realm.json` (KC_DB=dev-file persists the `harvoost-keycloak-data` volume) — only relevant if the realm changes (it should not here).

## Next step
Dispatch `debugger` to reproduce the loop in a real browser (Playwright `chromium-live` via `tests/e2e/`, capturing console + network) against the running stack, confirm both defects A and B with live evidence, and write `ROOT_CAUSE.md` + `HOTFIX_PLAN.md` + fix-lane recommendation. **Does NOT implement the fix.**

## HITL gates
- **(a)** After the debugger confirms root cause, before dispatching the fix.
- **(b)** Before pushing the commit. Commit + push to main (closes #3) only after gate (b).
