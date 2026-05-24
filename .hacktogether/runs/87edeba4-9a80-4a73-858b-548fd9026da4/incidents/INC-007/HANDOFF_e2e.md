---
phase: incidents/INC-007
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: complete-with-finding
---

# Summary
Verified the INC-007 hotfix (GitHub #9 — employee/project drill-in pages 400'd
because the rollup calls omitted `date_range`) live against the rebuilt Docker
stack as `admin@harvoost.local`. The fix DOES what it claims: both drill-in pages
now fire their rollup GET with a default `date_range` = current ISO week (Mon→Sun)
in the viewer TZ, and the API returns **200** (was a deterministic 400). However,
the drill-in pages STILL show an error surface end-to-end — NOT the old 400
ErrorBlock, but a client-side React **error-boundary crash** ("Something went
wrong" / "Cannot read properties of undefined (reading 'map')"). Root cause is a
SEPARATE, pre-existing **FE↔API contract drift** that the INC-007 fix uncovered:
the rollup payloads use `hours_by_project` / `hours_by_member`, but the pages read
`data.per_project.map(...)` / `data.members.map(...)`. So acceptance criteria #1/#2
of #9 ("the page loads the rollup") are NOT met end-to-end. The `date_range` fix is
necessary but not sufficient.

# Files touched
- tests/e2e/specs/inc007-drillin-rollup.spec.ts (new) — durable live regression
  spec, two tests sharing the live-gated serial + one-login-per-throttle-window
  harness from admin-pages-load.spec.ts:
    - TEST 1 (INC-007 fix proper) — PASSES: both drill-ins send
      `date_range=YYYY-MM-DD/YYYY-MM-DD` (current ISO week, Mon..Sun verified) and
      the rollup GET returns 200. Uses `test.step()` per check.
    - TEST 2 (acceptance #1/#2 end-to-end render) — FAILS (KNOWN-RED by design):
      page must render the rollup Card with no error surface; it shows the error
      boundary because of the contract drift. Turns GREEN once FE shape is
      reconciled with the API. Failure message names the exact drift.
- No fixture changes. The hermetic mock-api ships NO rollup handler, so these
  drill-in pages are not exercised in mocked mode — nothing to update there, and
  no hermetic outcome changed.

# What downstream agents need to know
- **NEW LATENT BUG (blocks #9 acceptance, was NOT in the INC-007 report):**
  FE↔API contract drift on BOTH rollup endpoints. Captured live (admin, 200):
    - `GET /v1/reports/employees/3/rollup?date_range=2026-05-18/2026-05-24` → 200
      body keys: `user, date_range, hours_by_project, timeline, exceptions`.
      Page reads: `data.per_project.map(...)`, `data.display_name`,
      `data.out_of_scope_project_count`, `data.out_of_scope_hours` → all undefined
      → `per_project.map()` throws.
    - `GET /v1/reports/projects/1/rollup?date_range=2026-05-18/2026-05-24` → 200
      body keys: `project, date_range, total_hours, hours_by_member, hours_by_task,
      budget`. Page reads: `data.members.map(...)`, `data.hours_budget`,
      `data.total_hours`, `data.project_name` → `members` undefined → crash.
  Why TS didn't catch it: the FE `EmployeeDrillIn` / `ProjectRollupRow` interfaces
  are hand-written FE-local types asserting the FE's *expectation*, not generated
  from the API, so `tsc` is green while runtime crashes. A follow-up (frontend OR
  a thin API field-name reconciliation) is needed to satisfy #9. This is a
  separate fix from INC-007 and outside this agent's mandate (apps/* off-limits).
- **The INC-007 date_range fix itself is correct and verified** — keep it. It is a
  prerequisite for the page ever rendering; the drift fix sits on top of it.
- IDs used (live seed, RBAC-visible to admin who is unrestricted):
  employee `userId=3` (alice@harvoost.local, has current-week entries),
  project `projectId=1` (Atlas (hourly)). Discovered via
  `docker compose exec postgres psql` (users/projects/time_entries) — not guessed.
- Running the live spec: it is live-gated (`E2E_LIVE=1`) + serial with
  one-login-per-60s pacing (shared AuthController 5/60s brute-force bucket). Run
  on a RESTED auth window:
    cd tests/e2e && E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
      specs/inc007-drillin-rollup.spec.ts --project=chromium-live --workers=1

# Open questions / unknowns
- None on INC-007's stated fix (it works). The open item is the contract-drift
  bug above, which a follow-up incident/PR must close for #9 to be truly done.

# Verification evidence
- LIVE TEST 1 (INC-007 fix) → PASS: employee + project rollup GETs sent
  `date_range=2026-05-18/2026-05-24` (current ISO week, Mon..Sun asserted) and
  returned 200. (1.1s)
- LIVE TEST 2 (acceptance #1/#2 render) → FAIL (by design): employee drill-in
  shows error boundary "Something went wrong" (24× resolved to 1 element) instead
  of the "Per project" Card. Screenshot/trace:
  tests/e2e/test-results/inc007-drillin-rollup-INC--ef8fd-r-the-rollup-no-ErrorBlock--chromium-live/
- Captured request URLs + statuses (direct browser-context probe, admin session):
    GET /v1/reports/employees/3/rollup?date_range=2026-05-18/2026-05-24 → 200
    GET /v1/reports/projects/1/rollup?date_range=2026-05-18/2026-05-24  → 200
- Hermetic baseline (`@harvoost/e2e`, chromium-mocked, E2E_SKIP_WEB_SERVER=1):
  WITHOUT new spec → 60 passed / 11 failed / 19 skipped.
  WITH new spec    → 60 passed / 11 failed / 21 skipped (the +2 skips are the new
  live-only tests skipping in mocked mode). The 11 failures are byte-identical to
  baseline (the known WSL `route.fulfill` artifacts: throttle ×1, auth ×1,
  chatbot ×6, csrf ×2, approvals ×1). ZERO new failures; 60 pass unchanged.
- No-regression (live): INC-004 `admin: dashboard` walk → PASS (team-dashboard +
  profitability 200 with date_range; the mirrored fix intact). INC-005 → no 429s
  across the whole admin walk + drill-in nav. INC-002/003 → sign-in worked, authed
  shell reached, no /login bounce (asserted by `expectAuthedShell` ×3).
