---
phase: incidents/INC-007
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Re-verified INC-007 (GitHub #9) against the freshly-rebuilt, healthy Docker stack
AFTER the approved reconciliation expansion (rollup responses reshaped to a pinned
contract + the FE reconciled to it). Signed in live as `admin@harvoost.local`
(chromium-live, real Keycloak handshake, http://localhost:3000). The previously
KNOWN-RED render assertion (TEST2 in `tests/e2e/specs/inc007-drillin-rollup.spec.ts`)
is now a NORMAL PASS: BOTH drill-in pages RENDER their rollup with no error surface.
The FE↔API contract drift from the prior run is fully closed — the employee page
reads `user.display_name` + `hours_by_project[]` + `out_of_scope_*`, the project page
reads `project.name` + `total_hours`/`billable_hours` + `hours_by_member[]`, and the
wire bodies match exactly. INC-007's headline (employee drill-in, formerly the RED
crash) and the project drill-in both render. Light no-regression (INC-002/003/004/005/006)
is green, and the hermetic `@harvoost/e2e` baseline is unchanged (60 pass / 11 fail /
21 skip — ZERO new failures).

# Files touched
- tests/e2e/specs/inc007-drillin-rollup.spec.ts (modified) — three changes, all in tests/e2e/:
  1. TEST2 flipped from KNOWN-RED to expected-GREEN (now a normal PASS render
     assertion; docstring rewritten to describe the post-expansion contract the
     FE reconciled to, no longer documenting a crash).
  2. trackApi() now best-effort captures the rollup response JSON body
     (`bodyKeys` + `body`) so the spec can confirm the PINNED WIRE SHAPE on the
     wire, not just the request URL.
  3. NEW CHECK 4 in TEST1 asserts the pinned shape (employee: nested `user` w/
     `display_name`, `hours_by_project[]`, top-level `out_of_scope_project_count`
     + `out_of_scope_hours`, and a drift-guard that flat `per_project` is gone;
     project: nested `project` w/ `name`, top-level `total_hours` +
     `billable_hours`, `hours_by_member[]`, drift-guard that flat `members` is
     gone). The captured keys are also console-logged for this handoff.
  ALSO: `expectRollupRendered()` success locator corrected. The rollup Card title
  ("Per project"/"Members") renders as a styled <div>, NOT a semantic heading
  (packages/ui Card.tsx) — only the PageHeader <h1> is a role=heading. The helper
  now anchors on the card-title TEXT scoped to role=main AND asserts at least one
  rendered list ROW (role=listitem within main) — the strongest proof the
  contract-drift `.map()` crash is gone (a row only exists if hours_by_* mapped).
  Seed-independent (no hardcoded member/project names). NOTE: the FIRST re-run
  surfaced this as a transient RED purely from the stale heading-role locator
  while the page itself rendered perfectly (screenshot confirmed "Alice Manager"
  + "Per project" + "Atlas (hourly) 11.7h" / "Orion (hourly) 0.2h", no error
  boundary); after correcting the helper, TEST2 is a stable PASS.
- No fixture changes. The hermetic mock-api still ships NO rollup handler, so the
  drill-in pages remain live-only — nothing to update there, and the hermetic
  outcome is unchanged.

# What downstream agents need to know
- **INC-007 (#9) is fully closed end-to-end.** The prior run's latent FE↔API
  contract drift (the only thing that blocked acceptance #1/#2) is resolved by the
  expansion. Both drill-in pages render the rollup; no error boundary, no
  ErrorBlock, no `reading 'map' of undefined`.
- **PINNED WIRE SHAPE confirmed live (admin, 200), captured field names:**
    - `GET /v1/reports/employees/3/rollup?date_range=2026-05-18/2026-05-24` → 200
      body keys (sorted): `date_range, exceptions, hours_by_project,
      out_of_scope_hours, out_of_scope_project_count, timeline, user`.
      (`user.display_name` present; `hours_by_project[]` is an array; the OLD flat
      `per_project` is gone.)
    - `GET /v1/reports/projects/1/rollup?date_range=2026-05-18/2026-05-24` → 200
      body keys (sorted): `billable_hours, budget, date_range, hours_by_member,
      hours_by_task, project, total_hours`.
      (`project.name` present; `total_hours` + `billable_hours` top-level;
      `hours_by_member[]` is an array; the OLD flat `members` is gone.)
  These match the FE types (apps/web/src/lib/api-types.ts `ProjectRollupRow`) and
  the employee `EmployeeDrillIn` view type exactly.
- **Out-of-scope "Other projects (N)" row:** admin is RBAC-unrestricted, so for
  employee 3 there are zero out-of-scope projects (`out_of_scope_project_count`
  is present but the summary row is conditionally not rendered) — per the task,
  this was confirmed-not-forced; the field is present on the wire and the page
  does not crash. The "Per project" list rendered the two real in-scope projects
  (Atlas 11.7h, Orion 0.2h).
- **No product defect found in this re-run.** The single intermediate test RED was
  a test-locator issue in this agent's own helper (heading-role vs Card-title-div),
  fixed within tests/e2e/. The pages themselves were correct on the first re-run.
- IDs used (live seed, RBAC-visible to admin): employee `userId=3` (Alice Manager,
  has current-week entries on Atlas + Orion), project `projectId=1` (Atlas (hourly),
  members Alice/Bob/Carol; current-week member = Alice). Same ids as the prior run.
- Running the live spec (needs a RESTED auth window — the 5/60s AuthController
  brute-force bucket is shared by oidc/login + callback + idp-info; one login
  spends ~4 slots, so space runs >60s apart):
    cd tests/e2e && E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
      specs/inc007-drillin-rollup.spec.ts --project=chromium-live --workers=1

# Open questions / unknowns
- None. INC-007's stated fix and the expansion that closes #9's acceptance are
  both verified live. No follow-up incident is required for #9.
- Pre-existing, NOT-INC-007: the admin Projects/Clients list pages have a BigInt
  -serialization 500 noted in INC-004's handoff (list endpoints still 200; the
  500 is a different surface). Unchanged by this run, outside INC-007 scope.

# Verification evidence
- LIVE TEST 1 (INC-007 fix + pinned wire shape) → PASS (1.4s): employee + project
  rollup GETs sent `date_range=2026-05-18/2026-05-24` (current ISO week, Mon..Sun
  asserted), returned 200, and the captured response bodies match the pinned
  contract field-for-field (see keys above; flat-field drift guards pass).
- LIVE TEST 2 (acceptance #1/#2 render) → PASS (1.3m): employee drill-in renders
  the "Per project" card with real rows (Atlas/Orion) and title "Alice Manager"
  (from user.display_name); project drill-in renders the "Members" card with a
  member row and title from project.name; NO error boundary, NO ErrorBlock, NO
  retry/try-again affordance on EITHER page.
    cd tests/e2e && E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
      specs/inc007-drillin-rollup.spec.ts --project=chromium-live --workers=1
    → 2 passed (1.4m)
- No-regression (live):
    - INC-006: specs/inc006-admin-users.spec.ts --grep n/a → 1 passed (4.0s);
      /admin/users renders table + role chips, GET /v1/users 200 (9 users), 0 page
      errors, 0 console errors.
    - INC-004/005/002/003: specs/admin-pages-load.spec.ts --grep "admin: dashboard"
      → 1 passed (5.5s); /dashboard team-dashboard 200 + /financial profitability
      200 (both with date_range), members/managers/clients CRUD round-trips 200/201,
      NO 429s across the whole admin walk (INC-005), sign-in reached the authed
      shell (INC-002/003). The 400 POST /v1/cost-rates and 400 DELETE /v1/clients/1
      are that spec's intentional referential-integrity assertions, not regressions.
    - INC-002/003 + INC-005 additionally exercised inside the INC-007 spec itself
      (single Keycloak login lands on the authed shell; no /login bounce; no 429s
      during drill-in nav).
- Hermetic baseline (`@harvoost/e2e`, chromium-mocked, E2E_SKIP_WEB_SERVER=1, full
  suite): 60 passed / 11 failed / 21 skipped — IDENTICAL to the documented baseline.
  The 11 failures are the known WSL `route.fulfill` artifacts, unchanged in set and
  count: approvals ×1, auth ×1, chatbot ×6, csrf ×2, throttle ×1. The 21 skips =
  19 baseline + 2 (the INC-007 live-only tests skipping in mocked mode). ZERO NEW
  failures; the 60 pass count is unchanged.
    cd tests/e2e && E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
      --project=chromium-mocked --workers=1
    → 60 passed / 11 failed / 21 skipped (1.0m)
- Stack health at run time: docker compose ps → api/web/keycloak/postgres/maildev
  healthy (azurite unhealthy, irrelevant to these paths).
