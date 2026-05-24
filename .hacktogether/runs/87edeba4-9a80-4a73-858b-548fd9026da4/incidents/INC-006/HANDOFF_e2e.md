---
phase: 05-test
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: PASS
---

# Summary
Verified INC-006 (GitHub #7) live against the freshly-rebuilt, healthy Docker stack
(web/api/keycloak/postgres all `healthy`). The Admin › Users page (`/admin/users`)
no longer crashes into the React error boundary: signed in as `admin@harvoost.local`
via the real Keycloak handshake, the users table renders with role chips, and
`GET /v1/users` returns a `roles[]` array per user (admin→`["admin"]`,
alice→`["manager"]`, finmgr→`["finmgr"]`). The "Edit roles" editor opens seeded with
the user's current roles pre-selected. NO page error, NO console error, NO
`TypeError: Cannot read properties of undefined (reading 'length')`, and notably NO
NEW latent surprise on the page (unlike #4's BigInt / #2's Avatar — this page is
clean). All four acceptance checks PASS. The hermetic `@harvoost/e2e` suite tally is
unchanged vs baseline (60 pass / 11 fail — the known WSL `route.fulfill` artifacts);
INC-006 added zero new failures. No fixture/mock-api change was required.

# Files touched
- tests/e2e/specs/inc006-admin-users.spec.ts (new) — durable live regression spec, checks 1–4 + light INC-002/003/005 no-regression. Reuses the hardened patterns from `admin-pages-load.spec.ts` (whole-file live gate, serial one-login-per-auth-window pacing, `expectAuthedShell`, captured-response tracking).

# What downstream agents need to know
- **No mock-api / fixture change needed.** The hermetic lane never exercises the
  `GET /v1/users` LIST endpoint — it is a catch-all 404 in `mock-api.ts` and no
  hermetic spec calls it. INC-006's new `roles` field therefore has no mocked-lane
  surface; the hermetic INC-006 coverage is the node-env unit test
  `apps/web/__tests__/inc006-users-roles-guard.test.ts`. I confirmed and did NOT add
  a redundant mocked handler (avoids drift).
- **No latent surprise found on `/admin/users`.** Zero `pageerror`, zero console
  `error` during the full admin walk (table render + list fetch + role-editor open).
  The streamlined-flow concern (a hidden second bug, à la #4/#2) did not materialise.
- **`admin` was already in `KEYCLOAK_PASSWORDS`** (`dev-admin-pass`) — no helper edit
  needed.
- INC-004 BigInt-500 on the list endpoints is no longer status-reproducible:
  `/v1/users`, `/v1/projects`, `/v1/clients` all return clean 401 unauthenticated
  (not 500), and authed `/v1/users` returned 200 with full data. All three
  `/admin/*` page shells return 200.

# Open questions / unknowns
- The hermetic SKIP count is 19 in this run vs the documented baseline's 15. This is
  not a regression: the delta is the live-only specs that skip cleanly in mocked
  mode (incl. my new live-only INC-006 spec, +1). The load-bearing numbers —
  60 pass / 11 fail — match the baseline exactly, and the 11 failures are the
  identical known WSL artifacts (none touch `/v1/users` or `/admin/users`).

# Verification evidence

## Per-check (live, chromium-live, 1 test, PASS — 3.6s)
- **Check 1 — page no longer crashes (HEADLINE): PASS.** `/admin/users` rendered the
  "User management" heading + the users table (`User` & `Roles` columnheaders
  visible), with `admin@harvoost.local` and `alice@harvoost.local` rows visible. NO
  "Something went wrong" boundary, NO redirect to `/timesheets`, NO `pageerror`/
  console TypeError. `pageErrors=[]`, `consoleErrors(count)=0`.
- **Check 2 — `GET /v1/users` returns roles: PASS.** Captured response:
  `200 GET /v1/users?page=1&page_size=50` → 9 users, every user object has a
  `roles[]` array. Known mapping confirmed: `admin@harvoost.local → ["admin"]`,
  `alice@harvoost.local → ["manager"]`, `finmgr@harvoost.local → ["finmgr"]`.
  200, not 500.
- **Check 3 — roles render: PASS.** Role chips visible in rows (admin row shows an
  `admin` chip; alice's row a `manager` chip). No row degraded to "No roles".
- **Check 4 — role editor seeds correctly: PASS.** Opened "Edit roles" for Alice →
  dialog "Edit roles — Alice Manager"; the `manager` checkbox was pre-checked and
  `admin`/`finmgr`/`employee` were NOT — i.e. `draft: new Set(user.roles)` seeded from
  the current roles. Cancelled without saving (seed state untouched, net-zero).
- **No-regression (light): PASS.** INC-002/003 sign-in round-trip succeeded with no
  `/login` bounce (signInAs landed on the authed shell). INC-005: zero `429`/
  `RATE_LIMITED` on `/v1/users` during the authed admin nav. INC-004: `/admin/users`,
  `/admin/projects`, `/admin/clients` shells all 200; list endpoints 401 (not 500).

Commands:
- `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test specs/inc006-admin-users.spec.ts --project=chromium-live --workers=1`
  → **1 passed (3.6s)**. Captured log:
  `200 GET /v1/users?page=1&page_size=50 (9 users; admin=["admin"], alice=["manager"], finmgr=["finmgr"]); pageErrors=[]; consoleErrors(count)=0`.

## Hermetic baseline (REQUIRED — zero new failures confirmed)
- `E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test --project=chromium-mocked --workers=4`
  → **60 passed / 11 failed / 19 skipped** in 17.5s.
- The 11 failures are exactly the documented known WSL `route.fulfill` artifacts:
  approvals (1), auth OIDC-callback (1), chatbot (6), csrf (2), throttle (1). None
  reference `/v1/users` or `/admin/users`. INC-006 added **zero new failures**.
- My INC-006 spec is whole-file `test.skip(!isLiveMode())` in the mocked lane (listed
  but skips at runtime) → it contributes the +1 to the skip count and nothing to the
  pass/fail tally.

## Failure screenshots
- None — all live checks PASSED, no failure artifacts produced for the INC-006 spec.
  (The 11 hermetic failures are pre-existing baseline artifacts with their own
  trace/screenshot under `tests/e2e/test-results/`, unchanged by INC-006.)

## Flakiness observed
- None for the INC-006 spec (single deterministic live pass). The 11 hermetic
  failures are the documented, stable WSL-environment artifacts, not flakiness
  introduced here.
