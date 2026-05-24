# FEAT-003 (GitHub #16) — Test Report

Run: 87edeba4-9a80-4a73-858b-548fd9026da4
Feature: project task management (create / edit / archive)
Date: 2026-05-24

## Unit & Integration

### Test runner / discovery
All packages use **vitest** (`vitest run`) wired through `turbo run test`
(`pnpm test` at root / `pnpm --filter <pkg> test` per package). `packages/ui` has
no `test` script (no tests) — not part of the 6-package count. Each package was
run individually to capture clean per-package counts.

### Per-package results

| Package | Files | Passed | Failed | Notes |
| --- | --- | --- | --- | --- |
| `@harvoost/api` | 47 | **425** | 0 | was 419 post-build; +6 added here (AC-5 role guard) |
| `@harvoost/web` | 16 | **196** | 0 | unchanged from frontend lane |
| `@harvoost/contract` | 1 | **154** | 0 | spec-derived; openapi.yaml unchanged by FEAT-003 |
| `@harvoost/jobs` | 7 | **40** | 0 | |
| `@harvoost/db` | 2 | **21** | 0 | |
| `@harvoost/shared` | 8 | **101** | **1** | the **1 known PRE-EXISTING** fail (see below) |

**Totals: 937 passed, 1 known pre-existing failure (not a regression).**

The single failure is `@harvoost/shared › RbacScopeService — Alice/Bob/Carol/Dave
worked example › throws RbacError on empty requesterId`. This is the documented,
accepted baseline failure (verify-baseline memory note) — it exists on clean
`main`, is unrelated to FEAT-003, and is NOT a regression.

> Baseline reconciliation: the dispatch quoted contract = 151, but the suite reports
> **154** and the contract spec (`03-api-design/openapi.yaml`) + contract test files
> are **unchanged** by FEAT-003 (`git diff` shows only `projects.controller.ts`
> among contract/openapi/controller files). The 154 figure is therefore the
> pre-existing baseline; the 151 in the dispatch is stale. Contract is fully green.

### AC → test coverage map

| AC | Behavior | Covered by | Status |
| --- | --- | --- | --- |
| AC-1 | Create (default `is_billable=true`) + `is_billable=false`; 201 + audit `project.task_create` | api `createProjectTask — AC-1 happy path` (string ids, coerced booleans, INSERT params, audit, finmgr allow, `is_billable:false`); web `createProjectTask (POST)` (POST body + `is_billable:false` wire) | ✅ |
| AC-2 | Edit name / billability; 200 + audit `project.task_update`; other field untouched | api `updateProjectTask — AC-2 rename + billability` (name-only / billable-only partial UPDATE, `updated_at NOW()`, audit); web `updateProjectTask (PATCH)` (partial body, path) | ✅ |
| AC-3 | Archive `is_active=false` (row NOT deleted — UPDATE not DELETE) + reactivate; audit `project.task_archive` / `project.task_update` | api `updateProjectTask — AC-3 archive` (archive→`task_archive`, reactivate→`task_update`); web archive/reactivate wire bodies. Row-not-deleted asserted at SQL level (UPDATE … RETURNING, no DELETE in controller) | ✅ |
| AC-4 | Empty/missing name → 400; empty PATCH `{}` → 400 (`minProperties:1`) | api `CreateProjectTaskSchema — AC-4` (empty name, missing name, default, strict) + `UpdateProjectTaskSchema — AC-4 empty PATCH → 400` (`{}` rejected, single field ok, strict) driven through the real `ZodValidationPipe` | ✅ |
| AC-5 | admin/finmgr allow; employee/manager → 403; unauth rejected; missing project / missing-or-cross-project task → 404 (no existence leak) | api `task write routes — AC-5 @Roles(admin,finmgr) guard` (**ADDED HERE** — real `RolesGuard` + real metadata: allow admin+finmgr, 403 employee/manager, reject no-user) + existing `createProjectTask — AC-5 unknown project 404` & `updateProjectTask — AC-5 404 cases` (missing project, missing/cross-project task, scoped no-leak, ownership SELECT scoping) | ✅ |
| AC-6 | Duplicate ACTIVE name → 400 `VALIDATION_FAILED` with `details.code='TASK_NAME_EXISTS'` (23505 mapped, not 500); archived same-name allowed (DB partial index) | api `createProjectTask — AC-6` + `updateProjectTask — AC-6` (23505 → `ValidationFailedError(TASK_NAME_EXISTS)`, no audit on conflict); web `surfaces the REAL duplicate-active-name envelope` + `isTaskNameExistsError` block (real 400+`details.code` envelope, forward-compat 422/409/top-level, negative cases) | ✅ |
| AC-7 | Admin Tasks UI create / edit / archive / reactivate | web `feat003-project-tasks.test.ts` covers the drawer's lib seam: `fetchAdminProjectTasks` (no `is_active` filter so archived show), `createProjectTask`, `updateProjectTask`, `buildTaskPatch` (never emits empty body), `isTaskNameExistsError`. Component is exercised at the contract/lib layer (no component-render harness in this repo's web tests) | ✅ (lib/contract level) |
| AC-8 | Task picker reflects new/archived tasks via queryKey invalidation | web `query keys (picker invalidation contract — AC-8)`: `adminTasksKey('42')==['admin','projects','42','tasks']` and `pickerTasksKey('42')==['projects','42','tasks']` (the exact key NewEntryForm/StartTimerControl use); picker pins `is_active=true` so archived disappear | ✅ |

### Tests added by tester
- `apps/api/test/unit/project-tasks-controller.test.ts` — appended one describe
  block, **+6 tests** (34 → 40), closing the AC-5 role-guard gap. The pre-existing
  suite asserted the 404/no-leak half of AC-5 but had NO test pinning the
  `@Roles('admin','finmgr')` decorator or the employee/manager → 403 / unauth
  behavior. The new block drives the **real** `RolesGuard` against the **real**
  decorator metadata (mirroring the `projects-members-managers.test.ts` precedent),
  proving: both write methods carry `['admin','finmgr']`; admin and finmgr are
  allowed; employee and manager are 403'd; a request with no user is rejected.

### Coverage gaps identified
- None outstanding. The one gap (AC-5 role-guard contract on the two new write
  methods) was closed by the added tests above.
- Note (not a gap, by design): AC-7's React drawer component is verified at the
  lib/contract seam (`project-tasks.ts`), consistent with the repo's web test
  style (mocked-fetch lib tests; no component-render harness exists). The wire
  bodies, query-key invalidation, empty-body avoidance, and error mapping the
  drawer depends on are all pinned.

### Typecheck
- `pnpm --filter @harvoost/api typecheck` (`tsc --noEmit -p tsconfig.json`) → **exit 0, clean** (after the test additions).
- `pnpm --filter @harvoost/web typecheck` (`tsc --noEmit`) → **exit 0, clean**.

### Known gotchas (noted, NOT treated as gates/regressions)
- `nest build` for the API fails repo-wide (`TS6059 rootDir`, pre-existing on
  `main`; dev runs via ts-node). Verified via typecheck + vitest instead, per dispatch.
- `pnpm lint` / `next lint` fails on a pre-existing ESLint v9 config/CLI
  incompatibility (affects the whole repo, unrelated to FEAT-003). Not run as a gate.

### Production bugs found
- None.

### Regressions: none
The only failing test is the 1 known pre-existing `@harvoost/shared`
`RbacScopeService` empty-requesterId fail. No new failures anywhere.
