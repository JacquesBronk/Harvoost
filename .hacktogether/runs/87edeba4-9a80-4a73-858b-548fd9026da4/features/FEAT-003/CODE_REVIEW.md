# FEAT-003 (GitHub #16) — Code Review: Project task management

**Reviewer:** code-reviewer · **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4 · **Date:** 2026-05-24
**Verdict:** CLEAN — no blocking or critical findings. Approve for merge. No auto-loop back to build.

## Scope
`apps/api/src/projects/projects.controller.ts` (createProjectTask, updateProjectTask, assertProjectVisibleOrThrow, mapTaskNameConflict, mapTaskRow, the two Zod schemas); `apps/api/test/unit/project-tasks-controller.test.ts`; `apps/web/app/admin/projects/page.tsx` (TasksDrawer, describeTaskError); `apps/web/src/lib/project-tasks.ts`; `apps/web/src/lib/api-types.ts`; `apps/web/__tests__/feat003-project-tasks.test.ts`. Precedents traced: clients/billable-rates controllers, @harvoost/shared errors, http-exception.filter, zod pipe, api-client ApiError, NewEntryForm/StartTimerControl picker keys, openapi.yaml 909–959/3752–3775, migration.sql 128–141/147/184.

## AC adherence — all met
| AC | Requirement | Status |
| --- | --- | --- |
| AC-1 | Create (201, ProjectTask, audit `project.task_create`, is_billable default/override) | Met |
| AC-2 | Edit name + billability (200, partial update, updated_at bump, `project.task_update`) | Met |
| AC-3 | Archive via is_active=false only; no hard delete; history preserved; `project.task_archive` | Met |
| AC-4 | Empty/missing name → 400; empty PATCH {} → 400 (.refine minProperties:1) | Met |
| AC-5 | @Roles('admin','finmgr'); 401/403; 404 missing/non-visible project; 404 missing/cross-project task | Met |
| AC-6 | 23505 → TASK_NAME_EXISTS domain error (not 500); race-safe via partial unique index; archived same-name allowed | Met |
| AC-7 | Admin Tasks drawer: list (no is_active filter), add, inline edit, archive/reactivate, client-side empty-name guard | Met |
| AC-8 | Picker sync — every write invalidates BOTH adminTasksKey and pickerTasksKey `['projects', projectId, 'tasks']` | Met |

Key confirmations: visibility-gate parity with `listTasks` (scoped-not-visible & missing both → 404, no 403/500 leak); PATCH double-scopes existence SELECT *and* UPDATE to (task_id, project_id) → cross-project IDOR closed; AC-6 relies purely on the DB partial unique index `project_tasks_active_name_unique ... WHERE is_active=TRUE` (no check-then-insert TOCTOU; archived same-name does not block a new active one); archive-not-delete preserves `time_entries.task_id` (SET NULL) and rate rows (CASCADE); all `$queryRawUnsafe` bind params (the only interpolated PATCH fragment is hardcoded column literals); FE ids stay strings (no #14-class Number()); `buildTaskPatch` never emits an empty body.

## Findings (minor / nit — non-blocking)
- **[minor] Dup-name HTTP status diverges from spec's 422.** Returns HTTP 400 `{ code:'VALIDATION_FAILED', details:{ code:'TASK_NAME_EXISTS' } }` because `ValidationFailedError` is hardwired to 400 in @harvoost/shared and that's the clients/billable-rates precedent the build was told to mirror. Codebase-convention-over-contract; FE narrows on `details.code` so UX is correct. A literal 422/409 would need a new `ConflictError extends DomainError` affecting all constraint mappings — out of FEAT-003 scope. **Recorded as a Decision.**
- **[nit]** `mapTaskNameConflict` return type `unknown` (cosmetic; matches sibling catch idiom).
- **[nit]** `name` `.max(200)` is stricter than the contract (minLength:1 only) — deliberate, matches sibling project/client bounds.

## Praise
The cross-lane seam fix (AC-6 error envelope) is exemplary: extracted a pure, unit-testable `isTaskNameExistsError` with a safe `detailCodeIs` narrower and rewrote the test to the **real** envelope + negative cases. RBAC tests drive the real RolesGuard against real `@Roles` metadata (no mock). Audit semantics distinguish `project.task_archive` and verify a conflict records nothing.

## Quality: Correctness 5 · Testing 5 · Design 5 · Consistency 5. Auto-loop: none.
