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
// INC-007 extends it again to the two report rollup drill-in endpoints
// (`GET /v1/reports/employees/{param}/rollup`,
//  `GET /v1/reports/projects/{param}/rollup`). These had sat in KNOWN_SPEC_GAP
// since v0.1.0 ("spec not yet updated") — the OpenAPI spec never declared their
// response shapes, which is exactly why a FE↔API drift on them went uncaught and
// crashed the drill-in pages. They are now spec'd (single rollup objects, NOT
// `{ items }` envelopes), implemented, and FE-reconciled, so they move OUT of
// KNOWN_SPEC_GAP and INTO LOAD_BEARING with `shape: 'object'` (the success schema
// IS the rollup resource — no envelope key). `reads` lists the top-level fields
// the drill-in pages consume; the test FAILS if the spec ever drops one again.
// NOTE: keys are stored with `{param}` because loadSpec()/scan-frontend both
// normalise every path interpolation to `{param}` (see normaliseSpecPath).
//
// FEAT-002 (issue #6) extends the same mechanism to the period/timesheet locking
// surface (Option F). Three new operations are now spec'd + routed:
//   - POST /v1/time-entries/{param}/submit — the week-submit route the FE already
//     calls (it was the INC-004 KNOWN_ROUTE_GAP; the route is now REGISTERED, so
//     it moves OUT of KNOWN_ROUTE_GAP and INTO LOAD_BEARING). The 200 body is the
//     submit result object `{ submitted_ids, skipped }` (NOT an envelope), so
//     shape 'object' + empty envelopeKey resolves its own top-level props.
//   - GET /v1/timesheet-periods/{param} — the self period read backing the FE
//     "week submitted/locked" banner. The 200 body is a single TimesheetPeriod
//     object (the open-shell variant omits `id` / nulls `week_start_date`), so
//     shape 'object' + empty envelopeKey resolves the period's own props. `reads`
//     are the load-bearing fields the banner consumes (status + the per-status
//     entry_counts rollup).
//   - GET /v1/timesheet-periods — the list (self + RBAC-visible). 200 body is
//     `{ data: TimesheetPeriod[] }`, so shape 'paginated-data' + envelopeKey
//     'data' resolves the per-row period schema.
//
// FEAT-002 EXPANSION (issue #6) rebuilds GET /v1/approvals/queue from raw
// per-entry TimeEntry rows into ENRICHED per-(user, ISO-week) rows. The 200 body
// is `{ data: ApprovalQueueItem[] }`, so shape 'paginated-data' + envelopeKey
// 'data' resolves the per-row ApprovalQueueItem schema. `reads` is the full set
// the approvals page (apps/web/app/approvals/page.tsx + .../final/page.tsx)
// consumes off each row — it would have FAILED against the old raw-row spec that
// lacked user_name / iso_week / total_hours. The `stage` query key is now a
// DECLARED param of the operation, so its stale KNOWN_PARAM_DRIFT entry is removed
// below.
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
  {
    // INC-007: /dashboard/employees/:id drill-in. The 200 response is a single
    // EmployeeRollup object (NOT an `{ items }` / `{ data }` envelope), so
    // shape 'object' + empty envelopeKey resolves the rollup schema's own
    // top-level props. `reads` are the top-level fields the page consumes
    // (`user`, off which the page reads `display_name`; the project breakdown;
    // and the out-of-scope summary). FAILS the build if the spec drops a rollup
    // field the page reads — it would have failed against the pre-INC-007 spec,
    // which declared NO response schema at all for this endpoint.
    key: 'GET /v1/reports/employees/{param}/rollup',
    envelopeKey: '',
    shape: 'object',
    reads: ['user', 'hours_by_project', 'out_of_scope_project_count', 'out_of_scope_hours'],
  },
  {
    // INC-007: /dashboard/projects/:id drill-in. The 200 response is a single
    // ProjectRollup object (NOT an envelope), so shape 'object' + empty
    // envelopeKey resolves the rollup schema's own top-level props. `reads` are
    // the top-level fields the page consumes (`project`, off which the page reads
    // `name` / `hours_budget`; the totals; and the per-member breakdown). FAILS
    // the build if the spec drops a rollup field the page reads.
    key: 'GET /v1/reports/projects/{param}/rollup',
    envelopeKey: '',
    shape: 'object',
    reads: ['project', 'total_hours', 'billable_hours', 'hours_by_member'],
  },
  {
    // FEAT-002 (issue #6): POST /v1/time-entries/{entry_id}/submit. The route is
    // now REGISTERED (it was the INC-004 KNOWN_ROUTE_GAP, removed below). The 200
    // body is the submit-result object `{ submitted_ids, skipped }` (NOT an
    // envelope), so shape 'object' + empty envelopeKey resolves its own props.
    // `reads` are the two top-level fields the result carries; FAILS the build if
    // the spec ever drops one. This entry also re-asserts the route is routed,
    // which is the assertion that flips the moment the gap entry is removed.
    key: 'POST /v1/time-entries/{param}/submit',
    envelopeKey: '',
    shape: 'object',
    reads: ['submitted_ids', 'skipped'],
  },
  {
    // FEAT-002 (issue #6): GET /v1/timesheet-periods/{iso_week} — the self period
    // read backing the FE "week submitted/locked" banner. The 200 body is a
    // single TimesheetPeriod object (the open-shell variant omits `id` and nulls
    // `week_start_date`; modelled as one object schema with those optional/
    // nullable rather than a oneOf so the row-prop resolver sees the full field
    // set). shape 'object' + empty envelopeKey resolves the period's own props.
    // `reads` are the load-bearing fields the banner consumes: the period status
    // and the per-status entry_counts rollup.
    key: 'GET /v1/timesheet-periods/{param}',
    envelopeKey: '',
    shape: 'object',
    reads: ['user_id', 'iso_year', 'iso_week', 'status', 'entry_counts'],
  },
  {
    // FEAT-002 (issue #6): GET /v1/timesheet-periods — the list (self +
    // RBAC-visible). The 200 body is `{ data: TimesheetPeriod[] }`, so shape
    // 'paginated-data' + envelopeKey 'data' resolves the per-row period schema
    // (note: this list envelope has no offset-pagination meta, but the resolver
    // only needs the `data` array key, which is present).
    key: 'GET /v1/timesheet-periods',
    envelopeKey: 'data',
    shape: 'paginated-data',
    reads: ['id', 'user_id', 'iso_year', 'iso_week', 'status', 'entry_counts'],
  },
  {
    // FEAT-002 EXPANSION (issue #6): GET /v1/approvals/queue, REBUILT this
    // expansion from raw per-entry TimeEntry rows into ENRICHED per-(user,
    // ISO-week) ApprovalQueueItem rows. The 200 body is `{ data:
    // ApprovalQueueItem[] }`, so shape 'paginated-data' + envelopeKey 'data'
    // resolves the per-row ApprovalQueueItem schema. `reads` is the full set the
    // approvals pages consume off each row (apps/web/app/approvals/page.tsx maps
    // r.user_name / r.iso_week / r.total_hours / r.status / r.submitted_at and
    // keys on r.id; the admin unlock-week button reads r.user_id + r.iso_week).
    // FAILS the build if the spec drops any of these — it WOULD have failed
    // against the old raw-row spec (TimeEntry rows lack user_name / iso_week /
    // total_hours). The `stage` query key is now a DECLARED param, so its stale
    // KNOWN_PARAM_DRIFT entry has been removed.
    key: 'GET /v1/approvals/queue',
    envelopeKey: 'data',
    shape: 'paginated-data',
    reads: ['id', 'user_id', 'user_name', 'iso_week', 'total_hours', 'status', 'submitted_at'],
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
  // leave list FE sends `mine`; spec scopes by RBAC + a `user_id` filter only.
  'GET /v1/leave/requests': ['mine'],
};

/**
 * FE-consumed endpoints that are registered as NestJS routes but are not (yet)
 * declared in openapi.yaml, and are OUTSIDE the INC-004 pinned contract (no row
 * in HOTFIX_PLAN). The 404-guard still applies (the routes exist); only the
 * spec-declaration assertion is relaxed.
 *
 * INC-007 closed the loop on the two report drill-in rollups that previously
 * lived here ("spec not yet updated") — they are now fully spec'd + in
 * LOAD_BEARING above, so they have been REMOVED from this list. The array is now
 * empty: there is no remaining FE-consumed endpoint missing a spec entry.
 */
export const KNOWN_SPEC_GAP: string[] = [];

/**
 * FE-consumed endpoints declared in openapi.yaml that have NO registered NestJS
 * route, OUTSIDE the INC-004 pinned contract (no HOTFIX_PLAN row). Genuine
 * latent 404s a future incident should fix; allowlisted so the INC-004 suite
 * stays green while the debt stays visible in the log.
 *
 * FEAT-002 (issue #6) CLOSED the last entry here: POST /v1/time-entries/{id}/submit
 * is now a REGISTERED route (`@Post(':id/submit')` on the time-entries
 * controller), so it has been removed from this list and promoted into
 * LOAD_BEARING above (declared + routed + read-field asserted). The array is now
 * empty: there is no remaining FE-consumed endpoint with a latent-404 spec/route
 * mismatch.
 */
export const KNOWN_ROUTE_GAP: string[] = [];
