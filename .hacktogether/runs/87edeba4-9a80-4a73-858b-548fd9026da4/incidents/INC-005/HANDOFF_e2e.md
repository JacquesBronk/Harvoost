---
phase: hotfix INC-005 (GitHub #8)
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Verified the INC-005 hotfix (over-aggressive rate limit) LIVE against the
freshly-rebuilt Docker stack and confirmed the hermetic suite added ZERO new
failures. Wrote a durable, live-gated regression spec
(`tests/e2e/specs/inc005-rate-limit.spec.ts`) proving the headline fix and the
preserved brute-force cap. Signed in once-per-window as Alice (manager) and Bob
(employee) through the real Keycloak handshake; captured every `/v1/*` response
on the wire. Result: routine authed reads are no longer capped at 5/60s
(definitively — an 80-read burst is all 200), the per-principal `global` bucket
is the only app-wide read limit, and the 5/60s `auth` brute-force cap on
login-init survives (6th POST → 429 + `Retry-After-auth`). All four no-regression
checks (INC-002/003/004, FEAT-001) hold. Scoped entirely to `tests/e2e/`.

# Files touched
- tests/e2e/specs/inc005-rate-limit.spec.ts (new) — durable live regression:
  Criterion 1(a) navigate+hard-refresh ZERO-429, Criterion 1(b) ~80-read burst
  all-200 + Bob independence sanity check, Criterion 3 login brute-force 5/60s
  preserved. Reuses the hardened `signInAs()` helper and the per-response
  instrumentation + auth-window pacing pattern from `auth-me-throttle.spec.ts`
  (INC-003). No fixture changes were needed.

# What downstream agents need to know

## Live verification — exact request/429 counts per check (all PASS)
- **Criterion 1(a)** (EXACT repro — navigate + hard-refresh in one 60s window):
  **40 `/v1` responses, 0 × 429.** Per-endpoint, all 0×429:
  `GET /v1/auth/me` ×10, `GET /v1/projects` ×7, `GET /v1/time-entries` ×7,
  `GET /v1/time-entries/running` ×10, `GET /v1/reports/team-dashboard` ×1,
  `GET /v1/schedules/dashboard` ×1, `GET /v1/leave/requests` ×1,
  `GET /v1/auth/idp-info` ×1, `POST /v1/auth/oidc/callback` ×1,
  `POST /v1/auth/oidc/login` ×1. The probe drove >20 reads (well past the old
  5-token budget), so the cap WOULD have fired pre-fix.
- **Criterion 1(b)** (AGGRAVATED — single-endpoint burst):
  Alice `GET /v1/time-entries/running` ×80 → **80 × 200, 0 × 429**
  (first non-200: none). Pre-fix the 5th would have 429'd. Bob (separate
  context, same host/IP) `GET /v1/time-entries/running` ×50 → **50 × 200,
  0 × 429** — light per-principal sanity check (Bob not starved by Alice's
  burst).
- **Criterion 3** (auth brute-force preserved): 6 rapid unauthenticated
  `POST /v1/auth/oidc/login` → attempts 1–5 = **201**, attempt 6 = **429
  RATE_LIMITED with `Retry-After-auth=60`** (CORS-readable in the browser).

## Criteria 2 & 4 — NOT brute-forced live (by design); boundaries are unit/hermetic-proven
- **Criterion 2 (per-principal independence boundary)** would require exhausting
  the 1000/60s budget to prove the boundary itself — impractical live. The
  boundary is unit-proven in
  `apps/api/test/unit/principal-throttler-guard.test.ts` (getTracker returns
  `user:<id>` for authed reqs vs `ip:<addr>` otherwise). The live Bob check in
  Criterion 1(b) is a SANITY check only, explicitly NOT the boundary.
- **Criterion 4 (transient-429 backoff + recover)** is covered hermetically by
  `apps/web/__tests__/inc005-query-429-backoff.test.ts`. I did NOT try to force a
  live read-429 (needs 1000 reqs). NOTE: the INC-003 live spec (Criterion 2)
  DOES exercise the generalized 429-backoff path end-to-end (forced 4×429 on
  `/me` → bounded backoff → recovers, 0 /login bounces), giving an incidental
  live confirmation that the shared `query-client.ts` retry change self-heals.

## Hermetic baseline — ZERO new failures from INC-005
- `chromium-mocked` full suite: **60 passed / 11 failed / 15 skipped** — matches
  the documented FEAT-001 baseline (~60 pass / 11 fail) EXACTLY. INC-005 added
  zero new hermetic failures.
- The 11 failures are the known WSL Playwright `route.fulfill` Set-Cookie / CSRF
  / throttle-simulator / chatbot infra artifacts, NONE of them in code that
  consumes the INC-005-touched `query-client.ts` / `api-client.ts`:
  `approvals.spec.ts:9`, `auth.spec.ts:74`, `chatbot.spec.ts` ×6,
  `csrf.spec.ts:30`, `csrf.spec.ts:144`, `throttle.spec.ts:70`. The auth /
  timesheet / leave / dashboard hermetic journeys (which DO exercise the query
  client) all PASS. No fixture/handler changes were needed to reflect the new
  429-retry behavior — the mock-api never emits a 429 on routine reads, so the
  retry path is exercised by the dedicated hermetic unit test, not the e2e
  mock-api.

## No-regression checks (all PASS, live)
- **INC-002** (post-login shell render): Alice & Bob both land on `/timesheets`,
  the Sign out control + Timesheets nav render, `GET /v1/auth/me` → 200; no
  error boundary.
- **INC-003** (no /me storm): `auth-me-throttle.spec.ts` re-run live → **2/2
  pass**. Criterion 1: 10× `/me` all 200, 0 × 429, 0 post-auth /login bounces.
  Criterion 2: forced 4×429 backs off + recovers, 0 bounces. Confirms the shared
  `query-client.ts`/`api-client.ts` changes did NOT regress INC-003.
- **INC-004** (BigInt list endpoints): `GET /v1/projects` returned 200 with data
  ×7 across the nav probe under Alice (manager) — no new 500. (`/v1/users`/
  `/v1/clients` were not driven by the manager nav fan-out; `/v1/users`-as-admin
  is #7's territory — no NEW 500 observed.)
- **FEAT-001** (timer): `GET /v1/time-entries/running` (the running-timer query)
  returned 200 throughout (×10 in nav, ×80 in Alice burst, ×50 in Bob burst) —
  light check holds.

## On-the-wire CORS confirmation (independent of the spec)
`Access-Control-Expose-Headers: Retry-After-global,Retry-After-auth,Retry-After`
present on every `/v1` response (verified via curl with `Origin:
http://localhost:3000`), so the browser fetch can read the throttler hint — the
load-bearing prerequisite for the frontend Fix D.

## Pacing note for re-runners
The live spec is `mode: 'serial'` and self-paces on the 60s `auth` fixed window
(`waitForAuthWindow`). If you run other login-bearing live specs back-to-back,
leave a clear 60s auth window between them, and run Criterion 3 (which
deliberately exhausts the IP-keyed auth bucket) LAST. Use `localhost:3000`
(NOT 127.0.0.1).

# Open questions / unknowns
- None blocking. Pre-existing (not mine): `tests/e2e` `tsc --noEmit` reports
  4 errors in `chatbot.spec.ts` (`Array.prototype.findLast` needs `lib:
  es2023`) — unrelated to INC-005 and present at baseline; my new spec
  type-checks clean. Flag for a separate tsconfig `lib` bump if e2e typecheck is
  gated in CI.

# Verification evidence
- `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 playwright test specs/inc005-rate-limit.spec.ts --project=chromium-live`
  → **3 passed (2.2m)**. Criterion 1(a) 40/0 429; Criterion 1(b) Alice 80/0,
  Bob 50/0; Criterion 3 5×201 + 6th 429 (Retry-After-auth=60).
- `E2E_SKIP_WEB_SERVER=1 playwright test --project=chromium-mocked`
  → **60 passed / 11 failed / 15 skipped** (== FEAT-001 baseline; 0 new failures).
- `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 playwright test specs/auth-me-throttle.spec.ts --project=chromium-live`
  → **2 passed (1.3m)** (INC-003 no-regression on shared query/api client).
- `curl -X OPTIONS/GET … /v1/projects -H 'Origin: http://localhost:3000'`
  → `Access-Control-Expose-Headers: Retry-After-global,Retry-After-auth,Retry-After`.
- `tests/e2e` `tsc --noEmit` → only pre-existing chatbot.spec.ts errors; the new
  spec is clean. No failure screenshots/traces (all live tests passed).
