// FEAT-003 (GitHub #16) — admin project-task write path.
//
// The Tasks panel on /admin/projects creates, renames, re-bills, archives and
// reactivates project tasks. These helpers pin the exact contract the API
// expects (openapi.yaml `createProjectTask` / `updateProjectTask`):
//   - POST /v1/projects/{project_id}/tasks  body { name, is_billable? } → 201 ProjectTask
//   - PATCH /v1/projects/{project_id}/tasks/{task_id} body (partial) → 200 ProjectTask
//
// Two contract traps the panel must honour:
//   - PATCH is `minProperties: 1` server-side — an EMPTY body is a 400. Callers
//     must only send the fields that actually changed (buildTaskPatch enforces
//     this and signals "nothing changed" so the UI can no-op without a request).
//   - ids (id, project_id, task_id) are STRINGS throughout (INC-004 / #14 BigInt
//     fix). Never Number() them.
//
// The admin Tasks drawer lists tasks WITHOUT the is_active filter (admins see
// archived tasks too), so it does NOT reuse fetchProjectTasks (which pins
// is_active=true for the time-entry picker). It shares the same path though, so
// every successful write must invalidate BOTH the admin list key and the picker
// key — see ADMIN_TASKS_KEY / pickerTasksKey below.

import { ApiError, apiFetch } from './api-client.js';
import type {
  CreateProjectTaskRequest,
  ProjectTask,
  UpdateProjectTaskRequest,
} from './api-types.js';

/** Stable error code the API raises for a duplicate ACTIVE task name (maps the
 * Postgres 23505 on project_tasks_active_name_unique).
 *
 * REAL envelope (clients/billable-rates precedent): the backend's
 * ValidationFailedError maps the 23505 to HTTP 400 with a TOP-LEVEL
 * `code: 'VALIDATION_FAILED'` and the stable code nested at `details.code`:
 *   400 { code: 'VALIDATION_FAILED', message, details: { code: 'TASK_NAME_EXISTS' } }
 * So the duplicate-name detection MUST look at `details.code`, not just the
 * top-level code/status. We also keep top-level + 422/409 checks for
 * forward-compatibility (harmless if the backend ever changes its mapping). */
export const TASK_NAME_EXISTS = 'TASK_NAME_EXISTS';

/** Narrow an `unknown` error-`details` payload and test its nested `code`. The
 * client types ApiError.details as `unknown`, so we guard before reading. */
function detailCodeIs(details: unknown, code: string): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { code?: unknown }).code === code
  );
}

/**
 * True when `err` is the API's duplicate-active-task-name error. Detects the
 * REAL envelope (HTTP 400, top-level `VALIDATION_FAILED`, `details.code` ===
 * TASK_NAME_EXISTS) AND the forward-compat shapes (top-level code === the stable
 * code, or status 422/409). Anything else is false so the caller falls through
 * to the generic message.
 */
export function isTaskNameExistsError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (detailCodeIs(err.details, TASK_NAME_EXISTS) ||
      err.code === TASK_NAME_EXISTS ||
      err.status === 422 ||
      err.status === 409)
  );
}

/** Admin drawer list key. Distinct from the picker key so the two queries (one
 * unfiltered for admins, one is_active=true for the picker) never collide. */
export function adminTasksKey(projectId: string): [string, string, string, string] {
  return ['admin', 'projects', projectId, 'tasks'];
}

/** The time-entry picker's query key (NewEntryForm / StartTimerControl both use
 * `['projects', projectId, 'tasks']`). Invalidating this on every write keeps the
 * picker in sync with admin create/archive/reactivate (AC-8). */
export function pickerTasksKey(projectId: string): [string, string, string] {
  return ['projects', projectId, 'tasks'];
}

/**
 * Admin list: ALL tasks for a project (active + archived). No is_active filter so
 * the panel can show archived tasks and offer Reactivate. Returns the `{ data }`
 * envelope; ids are strings.
 */
export function fetchAdminProjectTasks(
  projectId: string,
): Promise<{ data: ProjectTask[] }> {
  return apiFetch<{ data: ProjectTask[] }>(`/v1/projects/${projectId}/tasks`);
}

/**
 * Create a task. POST /v1/projects/{project_id}/tasks. Name is required and
 * trimmed by the caller; is_billable is only sent when explicitly false-or-true
 * here (we always send it so the toggle is authoritative). Returns 201 ProjectTask.
 */
export function createProjectTask(
  projectId: string,
  body: CreateProjectTaskRequest,
): Promise<ProjectTask> {
  return apiFetch<ProjectTask>(`/v1/projects/${projectId}/tasks`, {
    method: 'POST',
    body,
  });
}

/**
 * Update a task (rename / re-bill / archive / reactivate). PATCH
 * /v1/projects/{project_id}/tasks/{task_id}. `body` MUST be non-empty — pass the
 * output of buildTaskPatch and skip the call when it returns null.
 */
export function updateProjectTask(
  projectId: string,
  taskId: string,
  body: UpdateProjectTaskRequest,
): Promise<ProjectTask> {
  return apiFetch<ProjectTask>(`/v1/projects/${projectId}/tasks/${taskId}`, {
    method: 'PATCH',
    body,
  });
}

/**
 * Build a minimal PATCH body containing ONLY the fields that differ from the
 * current task. Returns null when nothing changed, so the caller can avoid the
 * empty-body 400 entirely (no request at all). Name is compared trimmed.
 */
export function buildTaskPatch(
  current: Pick<ProjectTask, 'name' | 'is_billable'>,
  next: { name: string; isBillable: boolean },
): UpdateProjectTaskRequest | null {
  const patch: UpdateProjectTaskRequest = {};
  const trimmed = next.name.trim();
  if (trimmed && trimmed !== current.name) patch.name = trimmed;
  if (next.isBillable !== current.is_billable) patch.is_billable = next.isBillable;
  return Object.keys(patch).length > 0 ? patch : null;
}
