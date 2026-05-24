---
phase: feature-intake (FEAT-003)
agent: product-analyst
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Produced `FEATURE_PLAN.md` for FEAT-003 (GitHub #16) — project task
create/edit/archive. This is an implement-to-an-existing-contract feature: the
`project_tasks` table, the `GET .../tasks` read path, the time-entry task picker,
and the `createProjectTask` / `updateProjectTask` OpenAPI paths all already exist.
The only gap is the write-path API handlers and an admin Tasks UI. No new design,
no migration, no contract change required.

# Files touched
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-003/FEATURE_PLAN.md` (new)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-003/HANDOFF.md` (new)

# Scope-assessment verdicts
- **Structural change (architecture): NO.** `project_tasks` already has every
  column/index/FK needed (`migration.sql` lines 128–141; `schema.prisma` model
  `ProjectTask`). Do not re-run architecture.
- **API change: NO.** `createProjectTask` (201→ProjectTask) and `updateProjectTask`
  (200→ProjectTask) plus all three schemas are already in `openapi.yaml`
  (lines 909–959, 3752–3775). Implement verbatim. Do not re-run api-design.
- **No DELETE is intended** — retirement is `PATCH is_active=false`. Confirmed
  correct: `time_entries.task_id` is `ON DELETE SET NULL` and
  `project_billable_rates.task_id` is `ON DELETE CASCADE`, so hard delete would
  destroy history. Marked `[ASSUMED]` in the plan.
- **Affected modules:** `apps/api/src/projects/projects.controller.ts` (add
  POST+PATCH, mirror `clients.controller.ts`); `apps/web/app/admin/projects/page.tsx`
  (add a `tasks` drawer kind reusing the members/managers pattern); optionally
  `apps/web/src/lib/api-types.ts` (request body types); `AppShell.tsx` only if UI
  opens to finmgr (default: no change). No new modules.

# What downstream agents need to know
- **RBAC reconciliation (decision logged):** spec = Admin/FinMgr; sibling project
  routes = `@Roles('admin')`; `/admin/projects` nav + page guard = `isAdmin` only.
  Recommendation: **API = `@Roles('admin','finmgr')` per spec** (copy
  `clients.controller.ts`), **UI = admin-only for v1** (Tasks panel lives inside
  the already-admin-only Projects page). Opening tasks to finmgr is a follow-up.
- **Uniqueness:** partial unique index `project_tasks_active_name_unique ON
  (project_id, name) WHERE is_active = TRUE`. Build must map Postgres `23505` to a
  clean `422`/`409` (stable code e.g. `TASK_NAME_EXISTS`), like
  `clients`/`billable-rates`. Archived names may collide with active ones; watch
  reactivation collisions (AC-6).
- **Empty PATCH body:** plan recommends `400` (honours `minProperties: 1`);
  existing `clients`/`projects` no-op `200` convention is an acceptable fallback —
  flagged as `[ASSUMED]`.
- **Picker:** `fetchProjectTasks` already filters `is_active=true`; archived tasks
  drop out of new-entry pickers automatically (AC-8). GET path is untouched.
- **Tests:** extend `apps/api/test/unit/project-tasks-controller.test.ts`;
  e2e precedent is `apps/api/test/e2e/time-entries-task-id.e2e.test.ts`.

# Open questions / unknowns
- Non-blocking, recommendations applied (see plan "Open decisions for the user"):
  (1) Tasks UI for finmgr? default admin-only UI / Admin+FinMgr API.
  (2) Empty PATCH → 400 vs no-op 200? default 400.
- No blocking questions. Build may proceed on the recommended defaults.

# Verification evidence
- Read `openapi.yaml` lines 880–959 + 3752–3775 → both write paths + 3 schemas
  present, no DELETE path → API-change = NO confirmed.
- Read `migration.sql` 128–160 + `schema.prisma` model ProjectTask → table +
  partial unique index + FKs (SET NULL / CASCADE) present → structural = NO,
  archive-not-delete confirmed.
- Read `clients.controller.ts` → `@Roles('admin','finmgr')` + ZodValidationPipe +
  AuditService precedent confirmed for the new handlers.
- Read `AppShell.tsx` (`/admin/projects` → `isAdmin`) + `rbac.ts`
  (`canSeeFinancialData` = admin|finmgr) → RBAC wrinkle confirmed and reconciled.
