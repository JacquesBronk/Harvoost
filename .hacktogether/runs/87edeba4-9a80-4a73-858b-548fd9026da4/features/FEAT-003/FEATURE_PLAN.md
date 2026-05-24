# Feature FEAT-003 — Project task management (create / edit / archive)

**GitHub issue:** #16
**Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
**Date:** 2026-05-24

## Reporter description (verbatim)
> Address GitHub issue #16 — project task management. The OpenAPI contract
> (`03-api-design/openapi.yaml`) already specs:
> - `POST /v1/projects/{project_id}/tasks` → `createProjectTask` (Admin/FinMgr),
>   body `CreateProjectTaskRequest { name (required, minLength 1), is_billable (default true) }`,
>   returns 201 `ProjectTask`.
> - `PATCH /v1/projects/{project_id}/tasks/{task_id}` → `updateProjectTask` (Admin/FinMgr),
>   body `UpdateProjectTaskRequest { name?, is_billable?, is_active? }` (minProperties 1).
>
> …but **only the GET list is implemented** in `apps/api/src/projects/projects.controller.ts`
> (`@Get(':project_id/tasks')`). There is **no task-management UI** on
> `apps/web/app/admin/projects/page.tsx` (it manages members + managers only).
> Tasks therefore only ever come from the DB seed (`packages/db/prisma/seed.ts`),
> so a project created via the UI has zero tasks and no way to add any → time
> entries can't be categorized by task.
>
> Implement the spec'd POST/PATCH endpoints plus an admin Tasks panel so projects
> created via the UI can have tasks added / edited / archived.

## Light intake summary

A project task is a categorization bucket under a project (e.g. "Development",
"Research"). The `project_tasks` table, the read-path `GET /v1/projects/{project_id}/tasks`
list, and the time-entry task picker (`fetchProjectTasks` in `NewEntryForm` /
`StartTimerControl`) already exist. The gap is purely the **write path**: there
is no way to create, rename, change billability, or retire a task except by
editing the DB seed. A project created through the admin UI therefore has zero
tasks forever, and its time entries cannot be categorized.

This feature implements the two write endpoints that are **already specified in
`openapi.yaml`** (`createProjectTask`, `updateProjectTask`) and adds a Tasks
management panel to the existing admin Projects page, mirroring the
members/managers drawer pattern already on that page. Archive (retire) is done
by `PATCH is_active=false` — there is intentionally no DELETE (see Scope
assessment). This is an implement-to-an-existing-contract job, not a new design.

## Investigation findings (what already exists)

- **DB table exists — no schema change.** `packages/db/prisma/schema.prisma`
  `model ProjectTask` and `migrations/20260522000000_init/migration.sql` define
  `project_tasks (id, project_id, name, is_billable DEFAULT TRUE, is_active
  DEFAULT TRUE, created_at, updated_at)`. There is a **partial unique index**
  `project_tasks_active_name_unique ON (project_id, name) WHERE is_active = TRUE`
  — so two *active* tasks in one project may not share a name, but an archived
  task may share a name with an active one. This constraint drives create/edit
  validation and the archive model.
- **GET list already implemented** in `projects.controller.ts`
  (`@Get(':project_id/tasks')`): project-visibility scoped via
  `RbacScopeService`, non-visible/non-existent → 404 (no existence leak),
  optional `is_active` filter, bigint ids `String()`-mapped. Unit-tested in
  `apps/api/test/unit/project-tasks-controller.test.ts`.
- **Endpoints already in the OpenAPI contract.** Lines 909–959 of
  `03-api-design/openapi.yaml` spec `createProjectTask` (201 → `ProjectTask`)
  and `updateProjectTask` (200 → `ProjectTask`); schemas at lines 3752–3775.
  **No DELETE path exists in the contract.**
- **Closest write-path precedent:** `apps/api/src/clients/clients.controller.ts`
  — `@Roles('admin','finmgr')` + `ZodValidationPipe` + `AuditService` on
  create/update; archive via `PATCH is_active=false`. The new endpoints should
  copy this shape almost verbatim.
- **Sibling project write routes** (`create`, `update`, `members`, `managers`)
  are all `@Roles('admin')` — narrower than the task spec's Admin/FinMgr.
- **Web Projects page** (`apps/web/app/admin/projects/page.tsx`) already has the
  exact pattern to reuse: a per-project drawer (Modal sized `lg`) for
  members/managers with list + add + remove sub-mutations, plus a project editor
  modal and an archive-confirm modal. A `tasks` drawer kind slots straight in.
- **Web nav** (`AppShell.tsx`) gates `/admin/projects` to `isAdmin` only;
  `canSeeFinancialData` (= admin OR finmgr) already exists in `rbac.ts` and is
  used for the Clients/Reports nav entries.
- **Downstream FK behaviour** (drives archive-not-delete): `time_entries.task_id`
  is `ON DELETE SET NULL`; `project_billable_rates.task_id` is `ON DELETE
  CASCADE`. A hard delete would silently null historical entry categorization and
  destroy per-task rate history. Archive (`is_active=false`) preserves both.
- **`ProjectTask` wire type** already exists in `apps/web/src/lib/api-types.ts`
  (string ids) — no new type needed for the picker; the admin panel can reuse it.

## Scope assessment

- **Structural change required (architecture):** **NO.**
  Justification: `project_tasks` already exists with every column the write
  endpoints need (`name`, `is_billable`, `is_active`, `updated_at`), the
  uniqueness rule, and the cascade/set-null FKs. No new table, column, index, or
  migration. Do **not** re-run `/hacktogether_architecture`.

- **API change required:** **NO** (implement-to-existing-contract).
  Justification: both `createProjectTask` and `updateProjectTask`, and all three
  schemas (`ProjectTask`, `CreateProjectTaskRequest` with `name` required /
  `is_billable` default true, `UpdateProjectTaskRequest` with `minProperties: 1`),
  are already in `openapi.yaml`. The build implements the existing spec verbatim.
  Two contract observations the build must honour rather than change:
  - **No DELETE is intended.** The contract has no `DELETE
    /v1/projects/{project_id}/tasks/{task_id}`. Retirement is `PATCH
    is_active=false`. This is the correct model given the FK behaviour above
    (deleting would SET NULL on historical time entries and CASCADE-delete rate
    history). **[ASSUMED: archive-via-PATCH is the intended retirement model;
    no DELETE is added.]** Justification: matches the contract, matches the
    project/client archive precedent, and preserves history. Flag for the user
    only if they explicitly want hard delete (not recommended).
  - The contract does not specify a uniqueness error. The DB partial unique index
    will raise on a duplicate *active* name; the build should map that Postgres
    `23505` to a clean `422`/`409` domain error (see acceptance criteria), the
    same way `clients`/`billable-rates` map constraint violations. This is an
    implementation detail, not a contract change. Do **not** re-run
    `/hacktogether_api_design`.

- **Affected modules:**
  - `apps/api/src/projects/projects.controller.ts` — add `@Post(':project_id/tasks')`
    (`createProjectTask`) and `@Patch(':project_id/tasks/:task_id')`
    (`updateProjectTask`), mirroring the clients controller (Zod pipe + audit) and
    reusing the project-visibility 404 gate already in `listTasks`.
  - `apps/web/app/admin/projects/page.tsx` — add a `tasks` drawer kind + a
    Tasks button on each project row + create/edit/archive sub-flows, reusing the
    members/managers drawer pattern.
  - `apps/web/src/lib/api-types.ts` — `ProjectTask` exists; add
    `CreateProjectTaskRequest` / `UpdateProjectTaskRequest` body types only if the
    page wants typed mutations (optional, nice-to-have).
  - `apps/web/src/components/AppShell.tsx` — touched **only if** the RBAC decision
    below opens the page to finmgr (see Open decisions). Default recommendation: no
    change (UI stays admin-only).
  - Tests: `apps/api/test/unit/project-tasks-controller.test.ts` (extend with
    create/update cases) and/or a new unit spec; optionally an e2e following the
    existing `time-entries-task-id.e2e.test.ts` precedent.

- **New modules:** None.

## RBAC reconciliation (decision required — recommendation given)

The contract says the task write endpoints are **Admin/FinMgr**, but the sibling
project write routes are `@Roles('admin')` and the `/admin/projects` page is
gated `isAdmin`-only in both `AppShell.tsx` (nav) and the page's own redirect
guard (`useEffect` → "Project management is available to Admin only.").

**Recommendation (v1):**
1. **API: implement faithfully to the spec** — `@Roles('admin','finmgr')` on both
   `createProjectTask` and `updateProjectTask`. This matches `openapi.yaml` and
   the `clients.controller.ts` precedent, and keeps the contract honest. Do not
   narrow to admin-only on the API.
2. **UI: keep the Tasks panel admin-only for v1.** The entire `/admin/projects`
   page (project create/edit/archive, members, managers) is admin-only today; the
   Tasks panel lives inside that page, so it inherits admin-only access. Opening
   *just* tasks to finmgr would require either splitting the page or relaxing the
   whole page's guard — both are larger than this tightly-scoped feature warrants.
   The API remaining Admin/FinMgr means a finmgr can still manage tasks via the
   contract (e.g. future surface or API client) even though the v1 admin UI does
   not expose it to them.

**[ASSUMED: UI stays admin-only in v1; API is Admin/FinMgr per spec.]** This is a
genuine product decision — see "Open decisions for the user" at the end. If the
user wants finmgr to reach the Tasks UI, the simplest path is to add a
finmgr-reachable entry point (e.g. surface tasks from the finmgr-visible Rates or
a dedicated page) rather than relaxing the admin-only Projects page; that is a
follow-up, not part of FEAT-003.

## Acceptance criteria

### AC-1 — Create a task (happy path)
- **Given** an authenticated Admin (or FinMgr) and an existing, visible project P,
  **When** they `POST /v1/projects/{P}/tasks` with `{ "name": "Development" }`,
  **Then** the API returns `201` with a `ProjectTask` body
  `{ id, project_id: P, name: "Development", is_billable: true, is_active: true }`
  (ids as strings), a row is inserted in `project_tasks`, and an audit entry
  `project.task_create` is recorded with the actor and the created task id.
- **Given** the same, **When** the body sets `"is_billable": false`,
  **Then** the created task has `is_billable: false`.

### AC-2 — Edit a task name and billability
- **Given** an existing active task T in project P and an Admin/FinMgr,
  **When** they `PATCH /v1/projects/{P}/tasks/{T}` with `{ "name": "Dev (renamed)" }`,
  **Then** the API returns `200` with the updated `ProjectTask` reflecting the new
  name, `updated_at` advances, and an audit entry `project.task_update` is recorded.
- **Given** the same, **When** they `PATCH` with `{ "is_billable": false }`,
  **Then** the returned task has `is_billable: false` and `name` is unchanged.

### AC-3 — Archive (deactivate) a task
- **Given** an active task T in project P and an Admin/FinMgr,
  **When** they `PATCH /v1/projects/{P}/tasks/{T}` with `{ "is_active": false }`,
  **Then** the API returns `200` with `is_active: false`, the row is **not**
  deleted, existing `time_entries.task_id = T` rows are unchanged (not nulled),
  any `project_billable_rates` for T are unchanged, and an audit entry is recorded
  (`project.task_archive` recommended; `project.task_update` acceptable).
- **Given** an archived task, **When** an Admin/FinMgr `PATCH`es `{ "is_active":
  true }`, **Then** it is reactivated (`200`, `is_active: true`) **provided** no
  other active task in P already holds that name (else AC-6 applies).

### AC-4 — Validation: empty / missing name rejected
- **Given** an Admin/FinMgr, **When** they `POST` to a project with `{ "name": "" }`
  or a body missing `name`, **Then** the API returns `400` (Zod/`ZodValidationPipe`,
  `name` minLength 1) and inserts nothing.
- **Given** an Admin/FinMgr, **When** they `PATCH` a task with an **empty body**
  `{}` (no updatable property), **Then** the API rejects it — either `400`/`422`
  (preferred, honouring the contract's `minProperties: 1`) or a no-op `200 { ok:
  true }` consistent with the existing `clients`/`projects` "no fields → ok"
  behaviour. **[ASSUMED: reject empty PATCH with 400 to honour `minProperties: 1`;
  if the build prefers the existing no-op convention, that is acceptable but note
  the divergence from the contract.]**

### AC-5 — RBAC: allowed roles succeed, others 403; unknown project 404
- **Given** an authenticated **employee** or **manager** (not admin/finmgr),
  **When** they `POST` or `PATCH` a task, **Then** the API returns `403`
  (`@Roles` guard) and no row is created/modified.
- **Given** an **unauthenticated** request, **Then** the API returns `401`.
- **Given** an Admin/FinMgr and a `project_id` that does not exist (or, for a
  scoped role, a project they cannot see), **When** they `POST`/`PATCH`, **Then**
  the API returns `404` (reusing the visibility/existence gate from `listTasks`),
  never leaking existence as `403`/`500`. Because admin/finmgr are unrestricted,
  the practical 404 case for them is a genuinely missing project.
- **Given** an Admin/FinMgr and a valid project P but a `task_id` that does not
  exist or belongs to a different project, **When** they `PATCH`, **Then** the API
  returns `404`.

### AC-6 — Duplicate active name rejected
- **Given** project P already has an **active** task named "Development",
  **When** an Admin/FinMgr `POST`s `{ "name": "Development" }` to P (or `PATCH`es a
  different active task in P to that name, or reactivates an archived task whose
  name collides with an active one), **Then** the API rejects with a clean domain
  error (`422` preferred, or `409`) carrying a stable code (e.g.
  `TASK_NAME_EXISTS`) — mapped from the Postgres `23505` on
  `project_tasks_active_name_unique`, not a raw `500`. **Given** P has an
  *archived* task named "Development", a new *active* "Development" is permitted
  (the unique index is `WHERE is_active = TRUE`).

### AC-7 — Admin Tasks UI: create / edit / archive
- **Given** an Admin on `/admin/projects`, **When** they open a project's **Tasks**
  panel, **Then** they see the project's tasks (name, billable badge, active/archived
  status) loaded via `GET /v1/projects/{P}/tasks` (no `is_active` filter, so
  archived tasks are visible to admins), with an "Add task" control.
- **Given** the Tasks panel, **When** the Admin adds a task with a name (and
  billable toggle), **Then** a `POST` is sent, the list refetches, and a success
  toast shows; an empty name is blocked client-side before the request (mirroring
  the project editor's `name.trim()` guard).
- **Given** an existing task in the panel, **When** the Admin edits its name or
  billability, **Then** a `PATCH` is sent and the list refetches.
- **Given** an active task, **When** the Admin archives it, **Then** a `PATCH
  { is_active: false }` is sent, the list refetches, and the task shows as
  Archived (an archived task offers a Reactivate action).
- **Given** a non-admin reaches `/admin/projects` directly, **Then** they are
  redirected away (existing guard) and never see the Tasks panel — consistent with
  the v1 admin-only-UI decision.

### AC-8 — Time-entry task picker reflects new / archived tasks
- **Given** an Admin creates a new active task T in project P,
  **When** any user who can log time on P opens the New Entry form / Start Timer
  control and selects P, **Then** T appears in the task picker (the picker calls
  `fetchProjectTasks(P)` → `GET .../tasks?is_active=true`).
- **Given** an Admin archives task T (`is_active=false`),
  **Then** T no longer appears in the task picker for new entries (because the
  picker filters `is_active=true`), while historical time entries already
  referencing T are unaffected (AC-3).

## Out of scope
- **Hard delete of tasks.** No DELETE endpoint; retirement is archive-only
  (`is_active=false`). Adding hard delete is explicitly deferred (and discouraged
  given FK SET NULL / CASCADE side effects).
- **Opening the Tasks UI to FinMgr.** API stays Admin/FinMgr per spec, but the
  v1 admin UI stays admin-only. A finmgr-reachable surface is a follow-up.
- **Reordering / sort-position, descriptions, colour, default-task selection, or
  per-task estimates/budgets.** The schema has none of these; adding them is a
  separate feature.
- **Bulk task operations** (bulk import, bulk archive) and CSV templating.
- **Cascading rename into reports/exports historical labels.** Renaming a task
  changes its current name everywhere it is read by id; no historical relabelling
  semantics are added.
- **Changing `listProjectTasks` RBAC / response shape.** The GET path is untouched.

## Risks
| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Build hard-deletes instead of archiving, nulling historical `time_entries.task_id` and cascading rate rows | Low | High | AC-3 + Out of scope make archive-only explicit; no DELETE in contract; call out FK behaviour in HANDOFF |
| Duplicate-active-name `23505` surfaces as a raw 500 instead of a clean error | Medium | Medium | AC-6 mandates `23505` → domain `422`/`409` with stable code, copying the `clients`/`billable-rates` mapping precedent |
| RBAC implemented as admin-only on the API (copying sibling project routes) instead of Admin/FinMgr | Medium | Medium | RBAC reconciliation section + AC-5 fix the API at `@Roles('admin','finmgr')` per spec |
| Empty-PATCH handling diverges from the `minProperties: 1` contract | Medium | Low | AC-4 states the preferred 400 and the acceptable no-op fallback explicitly |
| Picker shows archived tasks (forgets `is_active=true` filter) | Low | Medium | AC-8 anchors on existing `fetchProjectTasks` (`is_active=true`); GET path unchanged |
| Reactivation collides with an existing active name | Low | Medium | AC-3 + AC-6 cover the reactivate-collision case |

## Open decisions for the user (non-blocking — recommendations applied)
1. **Tasks UI for FinMgr?** Recommended v1: **admin-only UI, Admin/FinMgr API**.
   Confirm, or request a finmgr-reachable surface (follow-up).
2. **Empty `PATCH` body:** Recommended **400** (honours `minProperties: 1`).
   Confirm, or accept the existing no-op `200 { ok: true }` convention.

Both have well-justified defaults; the build can proceed on the recommendations
if no answer is given.
