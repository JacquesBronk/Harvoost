---
phase: 05-test
agent: e2e-tester
started: 2026-05-23
finished: 2026-05-23
status: PASS
---

# Summary
Wrote and ran a durable, live-gated Playwright regression spec verifying the INC-003
hotfix (GitHub #3) against the already-running, freshly-rebuilt docker stack
(web :3000, api :3001, real Keycloak). The spec is the direct inverse of the
debugger's pre-fix repro (which observed 909 `GET /v1/auth/me` requests in 11.4s —
4×200 then 905×429 — and a spinner-wedged, /login-bouncing app). Both acceptance
criteria PASS live. Backend defect B (`/me` was on the 5/60s brute-force `auth`
bucket) and frontend defect A (transient 429 treated as "logged out" → redirect →
remount → refetch storm) are both confirmed dead with live network evidence.

# Files touched
- `tests/e2e/specs/auth-me-throttle.spec.ts` (new) — canonical, live-gated regression suite (2 tests).
- `.hacktogether/runs/87edeba4-.../incidents/INC-003/repro/auth-me-throttle.verify.spec.ts` (new) — scratch copy for the incident record.
- No `apps/api` / `apps/web` / `.github` / `infra/keycloak/realm.json` source touched (per constraints).

# Acceptance criteria — live results

## Criterion 1 — authenticated navigation + hard-refresh fires zero 429 on /me — **PASS**
Real Keycloak sign-in as Alice (manager), then 4 client-side navigations
(`/dashboard` → `/timesheets` → `/leave` → `/timesheets`) + 5 hard refreshes, all
inside one 60s window. Shell (Timesheets sidebar nav + Sign out control) asserted
visible at every step.
- **`/me` requests: 10 over ~1.2s — ALL `200`, ZERO `429`, zero other statuses.**
  (`/me` statuses: `[200×10]`.) Pre-fix repro saw **909 (905×429)**.
- **Bounded count** (10 « the < 60 ceiling) — no storm.
- **0 post-auth `/login` bounces.** (2 total `/login` navs observed = the legitimate
  sign-in ENTRY path `/login → Keycloak → /auth/callback → /timesheets`; the assertion
  is scoped to navigations AFTER auth settles, so the entry visit is correctly excluded.)
- Never wedged on "Loading Harvoost"; final URL `/timesheets`.

## Criterion 2 — forced 429 on /me backs off (no /login bounce, no storm) then recovers — **PASS**
Real sign-in, then `page.route('**/v1/auth/me', ...)` forces `429` with body
`{"code":"RATE_LIMITED","message":"ThrottlerException: Too Many Requests"}` and header
`Retry-After-auth: 2`. Hard refresh triggers an auth refetch under the forced 429;
observed ~9s; then intercept lifted and a reload lets real `/me` 200 again.
- **During the forced-429 window: only 4 `/me` requests, all `429`** (`[429,429,429,429]`)
  — bounded exponential backoff honoring `Retry-After-auth`, NOT a storm
  (< 20 ceiling; pre-fix would be hundreds).
- App stayed on the "Loading Harvoost" spinner during the window (transient state),
  **0 post-auth `/login` bounces.**
- **Recovery: authenticated shell re-rendered** (Sign out control visible, spinner
  gone, not on /login) after the intercept was lifted (3 recent real `/me`).

# Test runs (live, chromium-live, against running stack)
- Run 1: Criterion 1 FAILED on an over-broad `/login`-nav assertion (counted the
  legitimate sign-in entry visit). Criterion 1 behaviour itself was already correct
  (10×200, 0×429). **Spec/instrumentation fix only** (see below) — no app change.
- Run 2: Criterion 1 PASS; Criterion 2 FAILED on the same over-broad `/login`-nav
  assertion (during-window check already passed: 4×429, 0 storm). Same spec fix applied.
- Run 3 (final): **both PASS** — `2 passed (1.3m)`. (The ~1.2m wall-clock is the
  auth-throttle window pacing between the two real logins, not test slowness.)

# Fixture / spec fixes I made (no app source touched)
1. **`/login`-navigation assertion scoping (both tests).** The hardened live
   `signInAs()` flow legitimately enters via `/login` before the Keycloak redirect,
   so a raw "0 navigations to /login" assertion is wrong — it flags the normal entry
   path. Fixed by snapshotting the `framenavigated` index at the moment the session is
   confirmed authenticated (`navsAtAuth`) and asserting **0 POST-auth `/login` bounces**
   (the actual bug symptom), while still logging the total for transparency. This is the
   correct instrumentation for "did the app bounce back to /login", and is consistent
   with how oidc-flow.spec.ts reasons about the entry path.
2. The forced-429 route fulfillment echoes `access-control-allow-origin` /
   `-allow-credentials` headers so the cross-origin (`:3001`) credentialed fetch surfaces
   the 429 to React Query as a real 429 (not an opaque CORS network error) — i.e. it
   faithfully exercises the 429 code path the real throttler produces.

# What downstream agents need to know
- **INC-003 is verified fixed live. Both criteria PASS.** Safe to close #3 from the e2e angle.
- **Out-of-scope observation (NOT #3, do NOT act on it here):** during Criterion 1's
  aggressive 5×-hard-refresh burst, the timesheets DATA panel (`GET /v1/time-entries`,
  on the GLOBAL 300/60s bucket) intermittently rendered a "Could not load data — You are
  sending requests too quickly" RATE_LIMITED alert in one early run. This is a *different*
  endpoint than `/me` (every `/me` was 200), it did NOT wedge the shell and did NOT bounce
  to /login — the auth gate stayed healthy. It is a product/UX consideration for the global
  data bucket under rapid reloads, separate from the `/me` auth-loop bug. Did not test/fix it.
- I did not observe #4 (reporting-endpoint 400s) or #5 (timer) during these runs.
- The new spec is gated `test.skip(!isLiveMode())` and runs in the `chromium-live`
  project. It uses the same serial + one-login-per-60s-window auth-throttle pacing as
  oidc-flow.spec.ts (the login/callback endpoints remain on the 5/60s bucket by design).

# Open questions / unknowns
- None blocking. The global-bucket `/v1/time-entries` 429 under rapid reload (above) is a
  flagged-but-out-of-scope UX note for the orchestrator's decision log, not a #3 defect.

# Verification evidence
- `cd tests/e2e && E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test specs/auth-me-throttle.spec.ts --project=chromium-live` → **`2 passed (1.3m)`**
- Criterion 1 log: `total /me requests: 10 over 1.2s (200s=10, 429s=0, other=0); navigations to /login: 2 total (0 POST-auth bounces)`
- Criterion 2 log: `/me during forced-429 window: 4 (429s=4, 200s=0); navigations to /login: 2 total (0 POST-auth bounces); recovered: shell visible after lifting intercept`
- `pnpm exec tsc --noEmit` → zero type errors in `auth-me-throttle.spec.ts` (only pre-existing, unrelated `chatbot.spec.ts` `findLast` lib-target errors remain).
- Spec files: `tests/e2e/specs/auth-me-throttle.spec.ts` (canonical) + `incidents/INC-003/repro/auth-me-throttle.verify.spec.ts` (record copy).
