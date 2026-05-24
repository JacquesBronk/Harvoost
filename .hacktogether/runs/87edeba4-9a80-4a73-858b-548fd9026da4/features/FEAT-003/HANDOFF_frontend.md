# FEAT-003 (GitHub #16) — Frontend HANDOFF (Tasks management UI)

**Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
**Lane:** frontend (`--scope` mode — frontend only, no backend touched)
**Date:** 2026-05-24
**Status:** done

## Scope honored
Implemented ONLY the admin Tasks-management UI on the existing (already admin-only)
`/admin/projects` page, per AC-7 and AC-8. Did NOT touch `AppShell.tsx`, did NOT
relax any RBAC guard, and did NOT touch any backend code. Coded strictly to the
OpenAPI contract paths/shapes provided.

## Files touched
- `apps/web/app/admin/projects/page.tsx` — added a `tasks` drawer kind, a **Tasks**
  button on each project row, and a new `TasksDrawer` component (list + add +
  inline edit + archive/reactivate). Refactored the drawer Modal title/description
  to `drawerTitle()` / `drawerDescription()` helpers to cleanly accommodate the
  third kind.
- `apps/web/src/lib/project-tasks.ts` — **new** admin task write-path module:
  `fetchAdminProjectTasks`, `createProjectTask`, `updateProjectTask`,
  `buildTaskPatch`, the `TASK_NAME_EXISTS` constant, and the two query-key helpers
  `adminTasksKey` / `pickerTasksKey`. Mirrors the `time-entries.ts` contract-pinning
  style and uses the shared `apiFetch` wrapper (inherits its headers/credentials).
- `apps/web/src/lib/api-types.ts` — added optional `CreateProjectTaskRequest` /
  `UpdateProjectTaskRequest` body types (reused the existing `ProjectTask`).
- `apps/web/__tests__/feat003-project-tasks.test.ts` — **new** contract test
  (13 cases), mocked-fetch style matching `feat001-timer-wiring.test.ts`.

## UX added (the Tasks drawer)
On each project row there is now a **Tasks** button (ListChecks icon) that opens
the same `Modal` (`size="lg"`) used by Members/Managers. Inside:
- **List** of ALL tasks via `GET /v1/projects/{projectId}/tasks` with **no
  `is_active` filter**, so admins see archived tasks too (AC-7). Each row shows the
  task name, a Billable/Non-billable `Badge` (brand vs neutral), and an
  Active/Archived status `Badge` (success dot vs neutral dot), plus per-row actions.
- **Add task** control: a name `Input` + a Billing `Select` (Billable default =
  true) + an **Add** button. Empty name is blocked client-side (`name.trim()`,
  mirroring the project editor) before any request; Enter in the name field also
  submits. → `POST /v1/projects/{projectId}/tasks` with `{ name, is_billable }`.
- **Edit** (inline, one row at a time): rename and/or change billability, then
  **Save**. → `PATCH /v1/projects/{projectId}/tasks/{taskId}` with **only the
  changed fields** via `buildTaskPatch` — if nothing changed it closes without a
  request (never sends an empty body → avoids the server-side 400 on
  `minProperties: 1`).
- **Archive** (active task) → `PATCH { is_active: false }`; archived rows instead
  offer **Reactivate** → `PATCH { is_active: true }`.
- Loading / error / empty states all handled (`LoadingSpinner`, `ErrorBlock` with
  retry, `EmptyState`).
- ids are treated as **strings** throughout — no `Number()` anywhere (per the #14
  fix).

## Query keys invalidated (AC-8 — picker stays in sync)
On **every** successful mutation (create, edit, archive, reactivate) the drawer
calls `invalidateAll()` which invalidates BOTH:
- `adminTasksKey(projectId)` = `['admin', 'projects', projectId, 'tasks']` — the
  drawer's own unfiltered list (so it refetches and shows the change), and
- `pickerTasksKey(projectId)` = `['projects', projectId, 'tasks']` — the EXACT key
  used by the time-entry picker in both `NewEntryForm.tsx` (line 87) and
  `StartTimerControl.tsx` (line 57). Invalidating it means a newly-created active
  task appears in the picker and an archived task disappears from it (the picker's
  `fetchProjectTasks` pins `is_active=true`), satisfying AC-8.

A success toast fires on every successful write (`Task added` / `Task updated` /
`Task archived` / `Task reactivated`).

## Duplicate-name error handling
The drawer's `describeTaskError(err)` maps the API's duplicate-active-name error to
the friendly sentence **"A task with that name already exists in this project."**
It treats an `ApiError` as a duplicate when `err.code === 'TASK_NAME_EXISTS'` OR
`err.status === 422` OR `err.status === 409` (the plan said the API returns code
`TASK_NAME_EXISTS` at 422 or 409). All other errors fall through to the shared
`describeError`. This is surfaced inline under the Add/Edit controls and as an error
toast for archive/reactivate collisions (the reactivate-collision case in AC-6).
Uses the same `ApiError` / `describeError` mechanism as the clients page's 409
handling.

## Billable toggle decision
There is no Switch/Toggle component in `@harvoost/ui`. To stay within the existing
design system (no new dependency, accessible by default) the billable control is a
native `Select` with `Billable` / `Non-billable` options (default Billable). Each
edit `Select` has an `aria-label` (e.g. "Billing for Development").

## Verification (the real gates: typecheck + tests)
```
$ cd apps/web && pnpm typecheck
> tsc --noEmit
(clean — no output, exit 0)

$ cd apps/web && pnpm test
> vitest run
 Test Files  16 passed (16)
      Tests  193 passed (193)
```
Baseline was 180 passing; +13 new from `feat003-project-tasks.test.ts` (covers the
POST/PATCH wire bodies, the admin-list-has-no-is_active-filter contract, the picker
key equality, `buildTaskPatch` never emitting an empty body, the string-id
guarantee, and the `TASK_NAME_EXISTS` ApiError shape). All green.

`pnpm lint` (`next lint`) was NOT run as a gate — it fails on a pre-existing
ESLint-version/CLI-option incompatibility unrelated to this change (known gotcha
per the dispatch). Typecheck + tests are clean.

## What downstream agents need to know
- **Contract assumptions to confirm against the backend lane:** the duplicate-name
  error code is assumed to be `TASK_NAME_EXISTS` at HTTP 422 or 409, and the empty
  PATCH is assumed to be a 400 (the UI never sends one, so this is belt-and-braces).
  If the backend chooses a different code/status for the duplicate, the friendly
  mapping in `describeTaskError` (page.tsx) and `TASK_NAME_EXISTS` in
  `project-tasks.ts` are the two spots to adjust.
- **Decision (record in the run Decision log):** billable control implemented as a
  native `Select` (Billable/Non-billable) rather than a toggle, because no
  Switch/Toggle exists in `@harvoost/ui` — avoided introducing a new component.
- **Decision (already confirmed in dispatch):** the Tasks UI stays inside the
  admin-only `/admin/projects` page; `AppShell.tsx` and all guards untouched.
- The admin list query key `['admin', 'projects', projectId, 'tasks']` is
  intentionally distinct from the picker key `['projects', projectId, 'tasks']` so
  the unfiltered admin view and the `is_active=true` picker never collide in the
  cache; both are invalidated on every write.

status: done

---

## Seam fix (cross-lane integration — AC-6 duplicate-name error envelope)

**Date:** 2026-05-24

### Problem
The backend's duplicate-active-task-name error (AC-6) maps Postgres 23505 via
`ValidationFailedError` (clients/billable-rates precedent), returning:
`HTTP 400 { code: 'VALIDATION_FAILED', message, details: { code: 'TASK_NAME_EXISTS' } }`.
The drawer's `describeTaskError` matched only `err.code === TASK_NAME_EXISTS ||
err.status === 422 || err.status === 409` — NONE of which are true for the real
envelope (top-level code is `VALIDATION_FAILED`, status is 400, the stable code is
nested at `details.code`). The friendly message was dead code; the UI fell through
to the generic error.

### Code change (one-line condition, via a shared narrowing helper)
- `apps/web/src/lib/project-tasks.ts` — added a `detailCodeIs(details, code)` safe
  narrower (`ApiError.details` is `unknown`) and an exported
  `isTaskNameExistsError(err)` predicate. The new condition is:
  `detailCodeIs(err.details, TASK_NAME_EXISTS) || err.code === TASK_NAME_EXISTS ||
  err.status === 422 || err.status === 409` — i.e. the real `details.code` path is
  now detected, and the 422/409 + top-level-code checks are KEPT (harmless
  forward-compat). Placed in the lib that already owns the `TASK_NAME_EXISTS`
  contract constant so the logic is pure + unit-testable.
- `apps/web/app/admin/projects/page.tsx` — `describeTaskError` now delegates to
  `isTaskNameExistsError(err)` instead of the inline `instanceof ApiError && (...)`
  check; dropped the now-unused `TASK_NAME_EXISTS` import (kept `ApiError`, still
  used at line 738). No other behavior changed.

### Test update (fictional → real envelope)
`apps/web/__tests__/feat003-project-tasks.test.ts`:
- **OLD (the trap):** the duplicate-name case mocked `status 422` with body
  `{ code: TASK_NAME_EXISTS, message: 'duplicate' }` — a fictional envelope the
  backend never returns, so it stayed green while the UI was broken.
- **NEW:** the `updateProjectTask` case now mocks the REAL envelope —
  `status 400`, body `{ code: 'VALIDATION_FAILED', message, details: { code:
  'TASK_NAME_EXISTS' } }` — and asserts the thrown `ApiError` carries
  `{ status: 400, code: 'VALIDATION_FAILED', details: { code: TASK_NAME_EXISTS } }`.
- Added an `isTaskNameExistsError` describe block asserting the surfaced friendly
  message **"A task with that name already exists in this project."** for the real
  400+`details.code` envelope (the path that MUST be covered), plus the 422/409 and
  top-level-code forward-compat shapes, plus negative cases (unrelated 400, other
  detail code, missing/malformed details, non-ApiError) to prove safe narrowing.

### Verification evidence
- `cd apps/web && pnpm typecheck` → **clean, EXIT 0** (`tsc --noEmit`).
- `cd apps/web && pnpm test` → **16/16 passed in feat003-project-tasks.test.ts;
  196/196 passed overall** (was 193 — +3 from the rewritten/added detection cases).
- `pnpm lint` NOT run as a gate (pre-existing ESLint-version incompatibility — known,
  unrelated).
- No git commit/push performed.

status: done
