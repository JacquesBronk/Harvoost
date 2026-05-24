---
phase: 04-build/backend
agent: backend-dev
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
Implemented the two write-path endpoints for project tasks (FEAT-003 / GitHub #16)
that were already specified in `openapi.yaml` but unimplemented: `POST
/v1/projects/{project_id}/tasks` (`createProjectTask`, 201) and `PATCH
/v1/projects/{project_id}/tasks/{task_id}` (`updateProjectTask`, 200). Both are
`@Roles('admin','finmgr')` per the contract (intentionally wider than the
admin-only sibling project routes). They reuse the existing `listTasks`
visibility/existence 404 gate (no existence leak), validate bodies with
`ZodValidationPipe`, map the partial-unique-index collision (Postgres `23505`) to
a clean domain error instead of a raw 500, and record audit entries. No DB
migration, no DELETE route, no frontend touched. TDD: failing unit tests added
first, then implementation.

# Files touched
- `apps/api/src/projects/projects.controller.ts` (modified) — added
  `CreateProjectTaskSchema` + `UpdateProjectTaskSchema` (both exported for tests),
  `createProjectTask`, `updateProjectTask`, the private
  `assertProjectVisibleOrThrow` gate, the private `mapTaskNameConflict` 23505
  mapper, the module-level `mapTaskRow` wire-shape helper, and a `HttpCode` import.
- `apps/api/test/unit/project-tasks-controller.test.ts` (modified) — extended the
  existing GET spec with create/update/validation cases (17 → 34 tests).

# Request/response shapes, status codes, error codes (as implemented)

## POST /v1/projects/{project_id}/tasks — createProjectTask (201)
- Roles: `admin`, `finmgr`.
- Request body (Zod, `.strict()`): `{ name: string (min 1, max 200), is_billable?: boolean (default true) }`.
- Success: **201** with the `ProjectTask` shape
  `{ id: string, project_id: string, name: string, is_billable: boolean, is_active: boolean }`
  (bigint ids `String()`-mapped, booleans coerced — identical to `listTasks`).
- `INSERT INTO project_tasks (project_id, name, is_billable) VALUES (...) RETURNING ...` (parameterized).
- Audit: `action: 'project.task_create'`, `entityType: 'project_task'`, `entityId: <new task id>`,
  `after: { project_id, name, is_billable }`.

## PATCH /v1/projects/{project_id}/tasks/{task_id} — updateProjectTask (200)
- Roles: `admin`, `finmgr`.
- Request body (Zod, `.strict()` + `.refine` minProperties:1):
  `{ name?: string (min 1, max 200), is_billable?: boolean, is_active?: boolean }`.
- Existence: 404 if project missing/non-visible; 404 if `task_id` does not exist OR
  belongs to a different project (ownership `SELECT id ... WHERE id = $1 AND project_id = $2`).
- Updates only provided fields, bumps `updated_at = NOW()`, `RETURNING` the full
  `ProjectTask`. Returns **200** with the same `ProjectTask` shape as above.

## Status / error codes
- **400** — body validation failure (empty/missing `name`, empty PATCH body,
  unknown field). ZodError → mapped by `HttpExceptionFilter` to
  `{ code: 'VALIDATION_FAILED', message, details: { fields: [...] } }`.
- **401 / 403** — handled by the existing auth + `@Roles` guard (unauthenticated →
  401; employee/manager → 403). Not implemented in-controller; inherited.
- **404** — missing/non-visible project, or missing/cross-project task. `NotFoundError`
  → `{ code: 'NOT_FOUND' }`. No existence leak (non-visible collapses to 404, never 403/500).
- **Duplicate active name (AC-6)** — see below.

## Audit action names
- `project.task_create` — on create.
- `project.task_update` — on rename / billability change / reactivation (`is_active=true`).
- `project.task_archive` — when `is_active` is set to `false` in the PATCH body
  (DECISION: archive transition gets its own action; all other updates use
  `project.task_update`). Both use `entityType: 'project_task'`.

# What downstream agents need to know

- **23505 mapping → HTTP 400, NOT 422 (faithful to the precedent, divergence from the plan's "422 preferred").**
  The dispatch said map the duplicate-active-name collision to a stable code
  `TASK_NAME_EXISTS` (it noted "422 preferred; 409 acceptable") AND told me to
  "mirror the clients/billable-rates try/catch". Those two instructions conflict:
  in this repo `ValidationFailedError` is hardwired to **HTTP 400** with envelope
  `code: 'VALIDATION_FAILED'`, and the `clients`/`billable-rates` precedent puts
  the stable code in the `details` object (`{ code: 'CLIENT_HAS_PROJECTS' }` /
  `{ code: 'BILLABLE_RATE_CONFLICT' }`). I followed the **precedent the dispatch
  explicitly told me to mirror**, so a duplicate active name returns:
  `HTTP 400 { code: 'VALIDATION_FAILED', message: 'A task with that name already
  exists in this project.', details: { code: 'TASK_NAME_EXISTS' } }`.
  The stable code `TASK_NAME_EXISTS` is preserved exactly as requested — it lives
  in `details.code`, same shape as every other constraint mapping in the codebase.
  This is NOT a raw 500 (the AC-6 risk is mitigated). If the product genuinely
  wants the *HTTP status* to be 422/409, that requires a new `DomainError`
  subclass (e.g. a `ConflictError` at httpStatus 409) rather than reusing
  `ValidationFailedError` — flag it and I can add one, but it would diverge from
  every existing constraint-mapping in the repo. **Frontend should match on
  `details.code === 'TASK_NAME_EXISTS'`, not on the HTTP status.**
- **Archived same-name task does NOT block a new active one** — the partial unique
  index is `WHERE is_active = TRUE`, so reactivation/rename only collides with
  *active* peers. Handled by the DB; no app-level pre-check needed.
- **No DELETE route** — retirement is `PATCH { is_active: false }` only, per the
  contract and the FK behaviour (`time_entries.task_id ON DELETE SET NULL`,
  `project_billable_rates.task_id ON DELETE CASCADE`). Archiving preserves both.
- **Empty PATCH → 400** (DECISION CONFIRMED in dispatch). The
  `UpdateProjectTaskSchema.refine(...)` rejects `{}` with a ZodError → 400,
  honouring the contract's `minProperties: 1`. Did NOT use the no-op-200 convention.
- **`name` length cap = 200.** The DB column is `TEXT` (uncapped) and the openapi
  schema only sets `minLength: 1` (no max). I applied `.max(200)` defensively to
  match the sibling `CreateProjectSchema`/`CreateClientSchema` `name` bound. This
  is stricter than the contract but not a contract violation (the contract sets no
  max). Note for frontend: client-side max of 200 keeps UX consistent.
- **No deviation from openapi.yaml on paths/verbs/status codes/response shapes.**
  201 on create, 200 on update, `ProjectTask` body on both, exactly as specced.
- **Schemas are exported** (`CreateProjectTaskSchema`, `UpdateProjectTaskSchema`)
  so the unit tests can drive them through `ZodValidationPipe` directly (the
  routes validate via the `@Body(new ZodValidationPipe(...))` decorator, matching
  the clients/billable-rates precedent, so the pipe layer isn't hit by a direct
  controller-method call).
- **UI / RBAC reconciliation unchanged here**: the API is Admin/FinMgr per spec.
  Per the plan, the v1 admin Projects UI stays admin-only — that is the frontend
  agent's call; the API does not gate the UI.

# Open questions / unknowns
- HTTP status for the duplicate-name case is **400** (via the precedent), not the
  plan's "422 preferred". If the orchestrator/user wants a 409/422 status, that is
  a one-line follow-up (new `ConflictError extends DomainError`); the stable
  `details.code: 'TASK_NAME_EXISTS'` is already in place either way. Flagged above.
- Otherwise: None.

# Verification evidence
- `pnpm --filter @harvoost/api test -- project-tasks-controller` → **34 passed (34)**
  (was 17; +17 new covering AC-1..AC-6 at the controller + schema/pipe level).
- `pnpm --filter @harvoost/api test` (full API unit suite) → **47 files, 419 tests, all passed**.
- `pnpm --filter @harvoost/api typecheck` (`tsc --noEmit -p tsconfig.json`) → **exit 0, no errors**.
- Did NOT run `nest build` (known repo gotcha — it fails; typecheck + tests used instead, per dispatch).
- `eslint` not run as a gate: the repo's ESLint v9 has no `eslint.config.js`
  (pre-existing config-format mismatch, affects all files, not this change);
  `tsc` + vitest are the authoritative gates and both pass.

status: done
