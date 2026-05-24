---
phase: 04-build/frontend
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
Reconciled the two drill-in pages (`/dashboard/employees/:userId`, `/dashboard/projects/:projectId`)
to the PINNED rollup contract the backend-dev + api-designer lanes are shipping. After the
INC-007 `date_range` fix the rollup calls returned 200, but both pages then crashed with
`Cannot read properties of undefined (reading 'map')` because the FE-local types had drifted
from the actual response: the employee page read flat `display_name`/`per_project` and the
project page read flat `project_name`/`hours_budget`/`members`, none of which the API returns.
I updated the FE types and every `rollup.data.<field>` read to the nested shapes
(`user.*`, `hours_by_project`, top-level `out_of_scope_*`; nested `project.*`,
`hours_by_member`, top-level `billable_hours`), extracted the title/list render logic into
small node-env-testable view helpers (mirroring the INC-006 `roles-cell.tsx` pattern), and
added a hermetic render-regression test that renders both helpers against representative
pinned-shape objects and proves they crash on the OLD flat shape. The rendered UX is
unchanged (same cards/lists); only the field sources changed.

# Files touched
- apps/web/app/dashboard/employees/[userId]/page.tsx (modified) — title + per-project card now sourced from the view helpers/new shape
- apps/web/app/dashboard/employees/[userId]/rollup-views.tsx (new) — `EmployeeDrillIn` type + `employeeRollupTitle()` + `<EmployeePerProjectCard>`
- apps/web/app/dashboard/projects/[projectId]/page.tsx (modified) — title + budget + members cards now sourced from the view helpers/new shape
- apps/web/app/dashboard/projects/[projectId]/rollup-views.tsx (new) — `projectRollupTitle()` + `<ProjectBudgetCard>` + `<ProjectMembersCard>`
- apps/web/src/lib/api-types.ts (modified) — `ProjectRollupRow` reshaped to the nested project contract
- apps/web/__tests__/inc007-rollup-shape.test.ts (new) — 14 node-env render-regression tests
- apps/web/__tests__/inc007-drillin-date-range.test.ts (modified) — mock bodies + local type updated to pinned shapes (the prior `date_range` tests still assert)
- apps/web/vitest.config.ts (modified) — added `@ -> ./src` resolve alias so node-env tests can resolve runtime `@/...` imports in rendered component modules

# Field reconciliations per page
## Employee drill-in (`employees/[userId]`)
- `EmployeeDrillIn` type: flat `{ user_id, display_name, per_project, ... }` → nested
  `{ user: { id, display_name, email, timezone }, date_range, hours_by_project[],
  out_of_scope_project_count, out_of_scope_hours, timeline[], exceptions[] }`.
- Title: `drill.data.display_name` → `drill.data.user.display_name` (via `employeeRollupTitle`).
- "Per project" list: `drill.data.per_project.map` → `drill.data.hours_by_project.map`
  (item fields `project_id`/`project_name`/`hours` unchanged; the synthetic "Other projects"
  row is no longer in this array).
- Out-of-scope summary `<li>`: now sourced from top-level `out_of_scope_project_count` /
  `out_of_scope_hours` (same look + "Other projects (N projects)" text; shown only when count > 0).

## Project drill-in (`projects/[projectId]` + `ProjectRollupRow`)
- `ProjectRollupRow` type: flat `{ project_id, project_name, total_hours, billable_hours,
  hours_budget?, members[] }` → nested `{ project: { id, name, client_name, billing_mode,
  fixed_fee_amount, currency, hours_budget }, date_range, total_hours, billable_hours,
  hours_by_member[], hours_by_task[], budget? }`.
- Title: `rollup.data.project_name` → `rollup.data.project.name` (via `projectRollupTitle`).
- Budget: `rollup.data.hours_budget` → `rollup.data.project.hours_budget` (card still gated on
  truthiness; pct = `total_hours / project.hours_budget`).
- `total_hours`: unchanged (top-level). `billable_hours` kept top-level on the type (not
  rendered by this page today, matching prior behavior).
- Members list: `rollup.data.members.map` → `rollup.data.hours_by_member.map`
  (item fields `user_id`/`display_name`/`hours` unchanged).
- File swept: no remaining flat `rollup.data.<field>` reads — all go through the nested shape
  or the view helpers. `ProjectRollupRow` has no other consumer in `apps/web` (verified by grep).

# What downstream agents need to know
- DECISION: added a `resolve.alias` (`@ -> ./src`) to `apps/web/vitest.config.ts`. Required so
  node-env render tests can resolve a component module's *runtime* `@/...` import (the helpers
  import `@/lib/tz.js`'s `formatHours`); previously only type-only `@/` imports were used in
  tests and those are stripped by esbuild before resolution. This is additive and didn't change
  any existing test/typecheck result.
- DECISION: extracted page render logic into co-located `rollup-views.tsx` helpers (one per
  drill-in page) so the regression test renders the SAME code the page ships, rather than a
  copy. The full pages are `'use client'` (useParams/useQuery) and can't render under node-env;
  this mirrors the INC-006 `app/admin/users/roles-cell.tsx` extraction precedent. No new UI.
- The `date_range` work from the earlier INC-007 pass is preserved on both pages (current ISO
  week in viewer TZ, `enabled: !!dateRange`, range in queryKey). The `inc007-drillin-date-range`
  suite still passes; I only updated its mock bodies to the pinned shapes.
- `hours_by_task` is on the `ProjectRollupRow` type for contract fidelity but is intentionally
  not rendered (task list was not in the prior UX and the task said it's optional).
- Stayed strictly in `apps/web/*`. Did not touch `apps/api/*`, `openapi.yaml`, `tests/contract/*`,
  `.github/`, `query-client.ts`, or the OIDC flow.

# Open questions / unknowns
- None. The pinned contract was implemented exactly; if the backend lane's final shape adds the
  optional `budget` object with extra keys, `ProjectRollupRow.budget` is typed loosely
  (`{ hours_budget; [key: string]: unknown }`) and is not read by the page, so no drift risk.

# Verification evidence
- `pnpm --filter @harvoost/web typecheck` → clean (tsc --noEmit, no output). KEY GATE.
- `pnpm --filter @harvoost/web test` → 121 passed (11 files). Baseline was 107; +14 new in
  `inc007-rollup-shape.test.ts`. No prior tests regressed.
