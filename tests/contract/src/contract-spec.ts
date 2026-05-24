// The INC-004 pinned-contract expectations.
//
// `LOAD_BEARING` are the endpoints the hotfix is about. For these we assert,
// in addition to path+method+route existence, that:
//   - the FE's query keys are ALL declared parameters of the spec operation
//     (strict — a stray/renamed param fails the build), and
//   - the spec's success-response schema declares every field the FE reads
//     (the `reads` list below), at the documented envelope key (`items`/`data`).
// This is what would have caught Rows 1-2's items/project_name/hours drift.
//
// INC-006 extends the same mechanism (no new framework) to GET /v1/users so the
// list-item `roles` field-level drift that crashed /admin/users is caught at
// build time too — see the entry at the end of LOAD_BEARING.
//
// Three allowlists carry pre-existing, OUT-OF-SCOPE debt on endpoints the
// INC-004 lanes are NOT touching, so the suite stays green for the hotfix while
// still flagging the debt in the log. NEW drift on any other endpoint still
// fails. Keep these lists SMALL and shrinking — they document debt, they are
// not a place to hide new drift.

export interface EnvelopeExpectation {
  /** `${METHOD} ${pathTemplate}` */
  key: string;
  /** Top-level response envelope key the FE reads the array/object from. */
  envelopeKey: string;
  /**
   * Where the row schema lives relative to the success schema:
   *  - 'array-items': envelopeKey -> array -> items schema
   *  - 'object': the success schema itself is the resource (single POST echo)
   *  - 'paginated-data': allOf-merged `{ data: T[] }` (OffsetPaginated)
   */
  shape: 'array-items' | 'object' | 'paginated-data';
  /** Field names the FE reads off each row; spec schema MUST declare them. */
  reads: string[];
}

export const LOAD_BEARING: EnvelopeExpectation[] = [
  {
    key: 'GET /v1/reports/team-dashboard',
    envelopeKey: 'items',
    shape: 'array-items',
    // dashboard/page.tsx + api-types.ts TeamDashboardRow reads.
    reads: ['user_id', 'display_name', 'total_hours', 'hours_by_project'],
  },
  {
    key: 'GET /v1/reports/profitability',
    envelopeKey: 'items',
    shape: 'array-items',
    // financial/page.tsx + FinancialProjectRow reads (the renamed fields).
    reads: ['project_id', 'project_name', 'hours', 'revenue', 'cost', 'margin', 'margin_pct'],
  },
  {
    key: 'GET /v1/schedules/dashboard',
    envelopeKey: 'data',
    shape: 'array-items',
    reads: [
      'user_id',
      'user_display_name',
      'local_date',
      'scheduled_start',
      'scheduled_end',
      'scheduled_hours',
      'source',
    ],
  },
  {
    key: 'GET /v1/cost-rates',
    envelopeKey: 'data',
    shape: 'paginated-data',
    reads: ['user_id', 'rate', 'currency', 'effective_from', 'effective_to'],
  },
  {
    key: 'POST /v1/cost-rates',
    envelopeKey: '',
    shape: 'object',
    reads: ['user_id', 'rate', 'currency', 'effective_from'],
  },
  {
    key: 'GET /v1/billable-rates',
    envelopeKey: 'data',
    shape: 'paginated-data',
    reads: ['project_id', 'task_id', 'rate', 'currency', 'effective_from', 'effective_to'],
  },
  {
    key: 'POST /v1/billable-rates',
    envelopeKey: '',
    shape: 'object',
    reads: ['project_id', 'rate', 'currency', 'effective_from'],
  },
  {
    // INC-006: /admin/users crashed because the GET /v1/users list response
    // omitted `roles` while apps/web/app/admin/users/page.tsx reads it unguarded
    // (RolesCell -> user.roles.map/.length, and roleSet(user) seeds the role
    // editor). Same response envelope as cost-/billable-rates: the success
    // schema is OffsetPaginationMeta allOf { data: User[] }, so `paginated-data`
    // + envelopeKey 'data' resolves the per-row User schema. `reads` is the full
    // set the Users page consumes off each row; `roles` is the load-bearing
    // field this incident is about. This entry FAILS the build if the spec's
    // list-item User schema ever drops any of these (it would have failed
    // against the pre-fix spec/contract that did not cover this endpoint).
    key: 'GET /v1/users',
    envelopeKey: 'data',
    shape: 'paginated-data',
    reads: [
      'id',
      'email',
      'display_name',
      'timezone',
      'weekly_summary_opt_out',
      'is_active',
      'roles',
    ],
  },
];

/**
 * Pre-existing param drift on endpoints OUTSIDE the INC-004 scope. Each entry
 * whitelists FE query keys that are not declared in the spec for that operation.
 * `${METHOD} ${pathTemplate}` -> allowed extra (undeclared) keys.
 */
export const KNOWN_PARAM_DRIFT: Record<string, string[]> = {
  // timesheets/page.tsx still sends ISO start_at_*; spec uses date_from/date_to.
  'GET /v1/time-entries': ['start_at_from', 'start_at_to'],
  // approvals queue FE sends `stage`; spec models the inbox as RBAC-routed
  // (Manager=stage1 / FinMgr=stage2) with no `stage` param.
  'GET /v1/approvals/queue': ['stage'],
  // leave list FE sends `mine`; spec scopes by RBAC + a `user_id` filter only.
  'GET /v1/leave/requests': ['mine'],
};

/**
 * FE-consumed endpoints that are registered as NestJS routes but are not (yet)
 * declared in openapi.yaml, and are OUTSIDE the INC-004 pinned contract (no row
 * in HOTFIX_PLAN). The 404-guard still applies (the routes exist); only the
 * spec-declaration assertion is relaxed. Documents spec debt for a follow-up
 * that folds the report drill-in endpoints into the spec.
 */
export const KNOWN_SPEC_GAP: string[] = [
  // dashboard/projects/[projectId] drill-in — backend route exists
  // (@Get('projects/:projectId/rollup') on v1/reports), spec not yet updated.
  'GET /v1/reports/projects/{param}/rollup',
  // dashboard/employees/[userId] drill-in — backend route exists
  // (@Get('employees/:userId/rollup') on v1/reports), spec not yet updated.
  'GET /v1/reports/employees/{param}/rollup',
];

/**
 * FE-consumed endpoints declared in openapi.yaml that have NO registered NestJS
 * route, OUTSIDE the INC-004 pinned contract (no HOTFIX_PLAN row). Genuine
 * latent 404s a future incident should fix; allowlisted so the INC-004 suite
 * stays green while the debt stays visible in the log.
 */
export const KNOWN_ROUTE_GAP: string[] = [
  // timesheets/page.tsx submits a week via POST /v1/time-entries/{id}/submit.
  // Spec declares /v1/time-entries/{entry_id}/submit, but the time-entries
  // controller registers no `:id/submit` route (only PATCH/DELETE :id). Latent
  // 404 the moment a user clicks "Submit week"; out of INC-004 scope.
  'POST /v1/time-entries/{param}/submit',
];
