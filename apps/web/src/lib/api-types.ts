// Manual minimal type definitions for the v1 Harvoost API.
//
// TODO(build-phase-followup): replace this file with output from
// `pnpm --filter @harvoost/web generate-types`, which runs
// `openapi-typescript` against ../../.hacktogether/runs/<id>/03-api-design/openapi.yaml
// and writes ./api-types.gen.ts. The generated file should be the
// authoritative source; this file becomes a thin re-export.
//
// Until generation is wired in, these hand-curated types cover the shapes
// the MVP pages need. Keep them in sync with openapi.yaml — these are NOT
// authoritative, the OpenAPI spec is.

export interface Paginated<T> {
  items: T[];
  next_cursor?: string | null;
  prev_cursor?: string | null;
  // Or, for offset-paginated endpoints:
  page?: number;
  page_size?: number;
  total_count?: number;
}

export interface ScopeMeta {
  visible_users: number; // -1 = unrestricted (admin/finmgr)
  visible_projects: number; // -1 = unrestricted
}

export interface ScopedList<T> {
  items: T[];
  scope_meta: ScopeMeta;
  next_cursor?: string | null;
}

export type EntryStatus =
  | 'running'
  | 'draft'
  | 'submitted'
  | 'manager_approved'
  | 'final_approved'
  | 'rejected';

export interface TimeEntry {
  id: string;
  user_id: string;
  project_id: string;
  project_name?: string;
  task_id?: string | null;
  task_name?: string | null;
  notes?: string | null;
  start_at: string;
  end_at?: string | null;
  hours?: number;
  status: EntryStatus;
  billable: boolean;
  mood_score?: number | null;
  // Cost fields may be omitted entirely for non-financial roles.
  cost_rate?: number | null;
  cost_amount?: number | null;
  billable_rate?: number | null;
  billable_amount?: number | null;
  user_timezone?: string;
}

/**
 * FEAT-001: `GET /v1/time-entries/running` returns `{ data: <entry> | null }`
 * (time-entries.controller.ts:148) — a single `{ data }` envelope, NOT the old
 * `{ running, today_total_hours, server_time }` shape this type used to claim.
 * Reading `.running` against the live backend always yielded `undefined`, so a
 * started timer never surfaced in `TimerBar`. Consumers must read `data.data`.
 * `today_total_hours` is NOT returned by the live endpoint; it is computed from
 * the week list where shown.
 */
export interface RunningTimerSnapshot {
  data: TimeEntry | null;
}

/**
 * FEAT-001: request body for `POST /v1/time-entries/start`.
 * Header `Idempotency-Key` is REQUIRED (attach via newIdempotencyKey()).
 * Returns the new entry UNWRAPPED (no `{ data }`).
 */
export interface StartTimerRequest {
  project_id: string;
  task_id?: string;
  notes?: string;
}

/**
 * FEAT-001: request body for `POST /v1/time-entries/switch`.
 * The LIVE controller validates `project_id` (SwitchSchema,
 * time-entries.controller.ts:34) — NOT the spec's `new_project_id`.
 * Header `Idempotency-Key` is REQUIRED. Returns the entry UNWRAPPED.
 */
export interface SwitchTimerRequest {
  project_id: string;
  task_id?: string;
  notes?: string;
}

/**
 * FEAT-001: request body for `POST /v1/time-entries` (manual create).
 * This route neither reads nor requires an `Idempotency-Key` header
 * (time-entries.controller.ts:300) — do NOT attach one. Datetimes are
 * ISO-8601 with the viewer's offset. Returns the entry UNWRAPPED (status `draft`).
 */
export interface CreateManualEntryRequest {
  project_id: string;
  task_id?: string;
  start_at: string;
  end_at: string;
  notes?: string;
}

export interface Project {
  id: string;
  name: string;
  code?: string | null;
  client_id: string;
  client_name?: string;
  billing_mode: 'hourly' | 'fixed_fee' | 'non_billable';
  is_active: boolean;
}

export interface ProjectTask {
  id: string;
  project_id: string;
  name: string;
  is_billable: boolean;
  is_active: boolean;
}

export interface TeamDashboardRow {
  user_id: string;
  display_name: string;
  total_hours: number;
  // INC-004: the team-dashboard endpoint also emits billable / non-billable
  // splits per row. The table does not render them today, but they are part of
  // the response shape, so keep them optional to stay aligned with the backend.
  billable_hours?: number;
  non_billable_hours?: number;
  hours_by_project: Array<{ project_id: string; project_name: string; hours: number }>;
  missed_punch_count: number;
  overtime_count: number;
}

/**
 * INC-007: `GET /v1/reports/projects/:projectId/rollup` returns a NESTED shape —
 * project metadata lives under `project` (not flat), member hours under
 * `hours_by_member` (was `members`), and the budget under `project.hours_budget`
 * (was top-level `hours_budget`). The FE previously read the flat fields the API
 * no longer emits, so `members.map` threw "Cannot read properties of undefined
 * (reading 'map')". `total_hours` / `billable_hours` remain top-level.
 */
export interface ProjectRollupRow {
  project: {
    id: string;
    name: string;
    client_name: string | null;
    billing_mode: string;
    fixed_fee_amount: number | null;
    currency: string;
    hours_budget: number | null;
  };
  date_range: { from: string; to: string };
  total_hours: number;
  billable_hours: number;
  hours_by_member: Array<{ user_id: string; display_name: string; hours: number }>;
  hours_by_task: Array<{ task_id: string | null; task_name: string; hours: number }>;
  // Present when `project.hours_budget` is set; treat as optional everywhere.
  budget?: { hours_budget: number | null; [key: string]: unknown };
}

export interface FinancialProjectRow {
  project_id: string;
  project_name: string;
  client_name?: string;
  billing_mode: 'hourly' | 'fixed_fee' | 'non_billable';
  revenue: number;
  cost: number;
  margin: number;
  margin_pct: number;
  hours: number;
  billable_hours: number;
  currency: string;
}

export interface LeaveRequest {
  id: string;
  user_id: string;
  user_name?: string;
  leave_type: 'annual' | 'sick' | 'unpaid' | 'other';
  start_date: string;
  end_date: string;
  half_day?: 'am' | 'pm' | null;
  note?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approved_by?: string | null;
  rejection_reason?: string | null;
}

export interface ExceptionRow {
  id: string;
  user_id: string;
  user_name?: string;
  exception_type:
    | 'MISSED_PUNCH'
    | 'OVERTIME_DAY'
    | 'OVERTIME_WEEK'
    | 'ANOMALY_LOW'
    | 'ANOMALY_HIGH';
  local_date: string;
  status: 'open' | 'resolved' | 'dismissed';
  details: Record<string, unknown>;
}

export interface ChatbotCapabilities {
  enabled: boolean;
  reason?: string;
  provider?: string;
  model?: string;
}

export interface ChatbotMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
  created_at: string;
}

export interface ChatbotConversation {
  id: string;
  started_at: string;
  last_message_at: string;
  title?: string | null;
}

export interface ChatbotSendResponse {
  conversation_id: string;
  reply: string;
  structured_data?: { columns: string[]; rows: unknown[][] } | null;
  tool_calls?: Array<{ name: string; params: unknown }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  provider?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Admin / management types — sourced from openapi.yaml § Users, Clients,
// Projects, Schedules. Hand-curated to unblock the admin UI in this pass.
// TODO(post-merge): regenerate from openapi-typescript and drop the manual
// re-export below — these shapes must stay in sync with the OpenAPI spec.
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'finmgr' | 'manager' | 'employee';

export interface User {
  id: string;
  email: string;
  display_name: string;
  roles: Role[];
  timezone: string;
  weekly_summary_opt_out: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OffsetPaginated<T> {
  page: number;
  page_size: number;
  total_count: number;
  data: T[];
}

export interface Client {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Optional fields exposed by some implementations of the clients endpoint.
  // Hand-tolerated here so the UI can show a project-count column when the
  // API returns it — falls back to `—` when undefined.
  projects_count?: number;
}

export type BillingMode = 'hourly' | 'fixed_fee' | 'non_billable';

export interface AdminProject {
  id: string;
  client_id: string;
  client_name?: string;
  code?: string | null;
  name: string;
  billing_mode: BillingMode;
  fixed_fee_amount?: number | null;
  currency: string;
  hours_budget?: number | null;
  department?: string | null;
  is_active: boolean;
  members_count?: number;
  managers_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  user_display_name?: string;
  user_email?: string;
  joined_at: string;
  left_at?: string | null;
}

export interface ProjectManagerAnchor {
  id: string;
  project_id: string;
  manager_id: string;
  manager_display_name?: string;
  manager_email?: string;
  assigned_at: string;
}

// ---------------------------------------------------------------------------
// Schedule overrides + dashboard rows
// ---------------------------------------------------------------------------

export type ScheduleOverrideScope = 'user' | 'project' | 'org';

export interface ScheduleOverride {
  id: string;
  scope: ScheduleOverrideScope;
  user_id?: string | null;
  project_id?: string | null;
  effective_from: string;
  effective_to: string;
  start_time?: string | null;
  end_time?: string | null;
  lunch_start_time?: string | null;
  lunch_end_time?: string | null;
  reason?: string | null;
  created_by: string;
  created_at: string;
}

export interface CreateScheduleOverrideRequest {
  scope: ScheduleOverrideScope;
  user_id?: string;
  project_id?: string;
  effective_from: string;
  effective_to: string;
  start_time?: string;
  end_time?: string;
  lunch_start_time?: string;
  lunch_end_time?: string;
  reason?: string;
}

export interface ScheduleDashboardRow {
  user_id: string;
  user_display_name: string;
  project_id?: string | null;
  local_date: string;
  scheduled_start: string;
  scheduled_end: string;
  scheduled_hours: number;
  source: 'template' | 'user_override' | 'project_override' | 'org_override';
  override_reason?: string | null;
}

// ---------------------------------------------------------------------------
// Rates — endpoints not yet in openapi.yaml (deferred to v1.0.1 per
// 07-deploy/TODO_INVENTORY.md). The UI here is shipped with the contract
// outlined in REQUIREMENTS F4 + ARCHITECTURE r2 § effective-dated rates.
// TODO(post-merge): replace with generated types once the backend cost-rates
// and billable-rates modules land.
// ---------------------------------------------------------------------------

export interface CostRate {
  id: string;
  user_id: string;
  user_display_name?: string;
  rate: number;
  currency: string;
  effective_from: string;
  effective_to?: string | null;
  created_by?: string;
  created_at: string;
}

export interface BillableRate {
  id: string;
  project_id: string;
  project_name?: string;
  task_id?: string | null;
  task_name?: string | null;
  rate: number;
  currency: string;
  effective_from: string;
  effective_to?: string | null;
  created_by?: string;
  created_at: string;
}

export interface FinalApprovalBatchRequest {
  action: 'approve' | 'reject';
  entry_ids: string[];
  reason?: string;
}

export interface ApprovalBatchResponse {
  approved_ids: string[];
  rejected_ids: string[];
  skipped?: Array<{ entry_id: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// FEAT-002 (GitHub #6) — period / timesheet approval locking (Option F).
// Shapes pinned by the backend HANDOFF (`>>> PINNED API SHAPES <<<`). The
// backend computes period status as a derived rollup of the user's non-running
// entries in the ISO-week (owner TZ). These are NOT authoritative — openapi.yaml
// is — but they mirror the pinned contract the FE consumes.
// ---------------------------------------------------------------------------

/** Derived period status rollup. `open` means the week is writable. */
export type TimesheetPeriodStatus =
  | 'open'
  | 'submitted'
  | 'manager_approved'
  | 'final_approved'
  | 'rejected';

/** Per-status entry counts inside an ISO-week period. */
export interface TimesheetPeriodEntryCounts {
  draft: number;
  submitted: number;
  manager_approved: number;
  final_approved: number;
  rejected: number;
}

/**
 * FEAT-002: `GET /v1/timesheet-periods/{iso_week}` (self) — a persisted period
 * row OR, when no row exists yet, a synthesized OPEN shell (which omits `id` and
 * returns `week_start_date: null`; same field set otherwise). `iso_week` here is
 * the numeric ISO week (e.g. 21), NOT the `YYYY-Www` token used in the URL.
 */
export interface TimesheetPeriod {
  id?: string;
  user_id: string;
  iso_year: number;
  iso_week: number;
  week_start_date: string | null;
  status: TimesheetPeriodStatus;
  submitted_at?: string | null;
  submitted_by?: string | null;
  manager_approved_at?: string | null;
  final_approved_at?: string | null;
  reopened_at?: string | null;
  entry_counts: TimesheetPeriodEntryCounts;
}

/** FEAT-002: `GET /v1/timesheet-periods` (list) envelope. */
export interface TimesheetPeriodList {
  data: TimesheetPeriod[];
}

/** FEAT-002: request body for `POST /v1/time-entries/{entry_id}/submit`. */
export interface SubmitTimeEntryRequest {
  scope?: 'entry' | 'week';
  iso_week?: string;
}

/** A reason an entry was skipped during a week submit. */
export type SubmitSkipReason = 'running' | 'already_submitted';

/**
 * FEAT-002: response from `POST /v1/time-entries/{entry_id}/submit`.
 * `submitted_ids` are string-encoded bigints; `skipped` carries a reason per
 * entry that was NOT submitted (a running timer, or an already-submitted entry).
 */
export interface SubmitWeekResponse {
  submitted_ids: string[];
  skipped: Array<{ entry_id: string; reason: SubmitSkipReason }>;
}

/** FEAT-002: request body for the admin unlock-week endpoint. */
export interface UnlockWeekRequest {
  /** Free-text justification — backend requires >= 20 chars. */
  reason: string;
}

/**
 * FEAT-002: response from
 * `POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock` (admin).
 */
export interface UnlockWeekResponse {
  unlocked_ids: string[];
  user_id: string;
  iso_year: number;
  iso_week: number;
}
