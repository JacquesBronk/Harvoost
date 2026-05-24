// FEAT-001 (GitHub #5) — shared time-entry mutation + picker-data library.
//
// Centralises every clock-in code path so the inline /timesheets control and the
// global TimerBar affordance share ONE implementation ("both" placements are one
// code path rendered in two places). Each function below pins the exact contract
// the LIVE controller expects, which diverges from openapi.yaml in two places —
// see the inline notes on switchTimer (field name) and fetchRunning (envelope).

import { apiFetch, newIdempotencyKey } from './api-client.js';
import type {
  CreateManualEntryRequest,
  OffsetPaginated,
  Project,
  ProjectTask,
  RunningTimerSnapshot,
  StartTimerRequest,
  SwitchTimerRequest,
  TimeEntry,
} from './api-types.js';

/** Manual entries may not exceed this duration (mirrors the controller's 24h cap). */
export const MAX_ENTRY_HOURS = 24;

/**
 * Start a timer. `POST /v1/time-entries/start`, REQUIRED `Idempotency-Key`
 * (a fresh key per submit), body `{ project_id, task_id?, notes? }`. The new
 * entry is returned UNWRAPPED (no `{ data }`). `task_id` / `notes` are omitted
 * when empty so we never send `task_id: ''` to the controller.
 */
export function startTimer(input: StartTimerRequest): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/v1/time-entries/start', {
    method: 'POST',
    headers: { 'Idempotency-Key': newIdempotencyKey() },
    body: compactEntryBody(input),
  });
}

/**
 * Re-point the RUNNING timer without stopping. `POST /v1/time-entries/switch`,
 * REQUIRED `Idempotency-Key`, body `{ project_id, task_id?, notes? }`.
 *
 * CONTRACT TRAP: the live controller validates `project_id` (SwitchSchema,
 * time-entries.controller.ts:34) — NOT the spec's `new_project_id`. Sending the
 * spec field would 422 live. We deliberately build to the controller.
 */
export function switchTimer(input: SwitchTimerRequest): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/v1/time-entries/switch', {
    method: 'POST',
    headers: { 'Idempotency-Key': newIdempotencyKey() },
    body: compactEntryBody(input),
  });
}

/**
 * Create a manual (back- or future-dated) entry. `POST /v1/time-entries`.
 *
 * CONTRACT TRAP: this route does NOT take an `Idempotency-Key` — do not attach
 * one. Body `{ project_id, task_id?, start_at, end_at, notes? }` with ISO-8601
 * datetimes (viewer offset). Returns the entry UNWRAPPED with status `draft`.
 */
export function createManualEntry(input: CreateManualEntryRequest): Promise<TimeEntry> {
  return apiFetch<TimeEntry>('/v1/time-entries', {
    method: 'POST',
    body: {
      project_id: input.project_id,
      ...(input.task_id ? { task_id: input.task_id } : {}),
      start_at: input.start_at,
      end_at: input.end_at,
      ...(input.notes ? { notes: input.notes } : {}),
    },
  });
}

/**
 * Read the canonical running-timer state. `GET /v1/time-entries/running` returns
 * the `{ data }` envelope (data is the entry or null) — read `data.data`.
 */
export function fetchRunning(): Promise<RunningTimerSnapshot> {
  return apiFetch<RunningTimerSnapshot>('/v1/time-entries/running');
}

/**
 * Active projects for the picker. `GET /v1/projects` returns the offset-paginated
 * `{ data, page, page_size }` envelope; project ids are strings. We request
 * `is_active=true` so archived projects do not clutter the picker.
 */
export function fetchProjectsForPicker(): Promise<OffsetPaginated<Project>> {
  return apiFetch<OffsetPaginated<Project>>('/v1/projects', {
    query: { page: 1, page_size: 100, is_active: true },
  });
}

/**
 * Tasks for a project. `GET /v1/projects/{project_id}/tasks` returns
 * `{ data: ProjectTask[] }`; ids (id, project_id) are STRINGS (INC-004 BigInt
 * fix). The task picker is OPTIONAL — a project may have zero tasks, which is a
 * valid "No tasks" state, not an error. `is_active=true` filters to live tasks.
 */
export function fetchProjectTasks(projectId: string): Promise<{ data: ProjectTask[] }> {
  return apiFetch<{ data: ProjectTask[] }>(
    `/v1/projects/${projectId}/tasks`,
    { query: { is_active: true } },
  );
}

/** Drop empty optional fields so we never POST `task_id: ''` / `notes: ''`. */
function compactEntryBody(
  input: StartTimerRequest | SwitchTimerRequest,
): { project_id: string; task_id?: string; notes?: string } {
  return {
    project_id: input.project_id,
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

export interface ManualEntryValidation {
  ok: boolean;
  error?: string;
}

/**
 * Client-side validation for a manual entry, run BEFORE any API call:
 *   - both bounds must parse,
 *   - end must be strictly after start ("End must be after start"),
 *   - duration must not exceed 24h.
 * Back-dating AND future-dating are allowed (gate (a) decision #3) — there is no
 * date floor or ceiling. `start`/`end` are ISO-8601 strings (with offset).
 */
export function validateManualEntry(start: string, end: string): ManualEntryValidation {
  if (!start || !end) {
    return { ok: false, error: 'Start and end are both required.' };
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { ok: false, error: 'Enter a valid start and end time.' };
  }
  if (endMs <= startMs) {
    return { ok: false, error: 'End must be after start' };
  }
  const hours = (endMs - startMs) / 3_600_000;
  if (hours > MAX_ENTRY_HOURS) {
    return { ok: false, error: 'An entry cannot exceed 24 hours.' };
  }
  return { ok: true };
}
