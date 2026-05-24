# FEAT-003 — Project task management (create / edit / archive)

**GitHub issue:** #16
**Filed during:** post-release admin-management audit (this session; siblings #13–#19; #14/#15 fixed in PR #20)

## Verbatim request

Address GitHub issue #16 — project task management. The OpenAPI contract
(`.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml`)
already specs:

- `POST /v1/projects/{project_id}/tasks` → `createProjectTask` (Admin/FinMgr),
  body `CreateProjectTaskRequest { name (required, minLength 1), is_billable (default true) }`,
  returns 201 `ProjectTask`.
- `PATCH /v1/projects/{project_id}/tasks/{task_id}` → `updateProjectTask` (Admin/FinMgr),
  body `UpdateProjectTaskRequest { name?, is_billable?, is_active? }` (minProperties 1).

…but **only the GET list is implemented** in `apps/api/src/projects/projects.controller.ts`
(`@Get(':project_id/tasks')`). There is **no task-management UI** on
`apps/web/app/admin/projects/page.tsx` (it manages members + managers only).
Tasks therefore only ever come from the DB seed (`packages/db/prisma/seed.ts`),
so a project created via the UI has zero tasks and no way to add any → time
entries can't be categorized by task.

Implement the spec'd POST/PATCH endpoints plus an admin Tasks panel so projects
created via the UI can have tasks added / edited / archived.

## Known wrinkle to resolve during intake/design

The OpenAPI spec says these endpoints are **Admin/FinMgr**, but the existing
project admin routes in `projects.controller.ts` are all `@Roles('admin')`, and
the `/admin/projects` nav entry is gated `isAdmin`-only in `AppShell.tsx`. The
design must reconcile who can manage tasks and where the UI lives so the allowed
roles can actually reach it.

## Downstream consumers (don't break)

- `fetchProjectTasks()` task picker in `NewEntryForm` / `StartTimerControl`.
- Per-task billable rates (`billable-rates.controller.ts`), `hours_by_task`
  reporting (`reports.controller.ts`), task columns in exports.
