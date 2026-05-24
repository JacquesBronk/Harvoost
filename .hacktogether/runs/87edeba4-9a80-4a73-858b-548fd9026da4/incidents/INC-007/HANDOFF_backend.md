---
phase: incidents/INC-007
agent: backend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Reshaped the two rollup responses in `apps/api/src/reports/reports.controller.ts`
to the PINNED INC-007 drill-in contract, resolving the FE↔API shape drift the e2e
lane uncovered (drill-in pages crashed reading `out_of_scope_*` / `billable_hours`
that the API never emitted, while the API emitted a synthetic null-id row the FE
choked on). No migration, no contract/openapi/web changes, no change to the other
endpoints (team-dashboard, profitability, time-rollup, detailed-activity). All RBAC
scoping, audit, and number/string coercion conventions preserved.

# Files touched
- apps/api/src/reports/reports.controller.ts (modified)
- apps/api/test/unit/reports-dashboard-endpoints.test.ts (modified)

# What downstream agents need to know

## Employee rollup — `GET /v1/reports/employees/:userId/rollup` (emitted shape, EXACT)
```
{
  user: { id, display_name, email, timezone },        // unchanged
  date_range: { from, to },                           // unchanged
  hours_by_project: [                                  // REAL in-scope projects ONLY
    { project_id: string, project_name: string, hours: number }
  ],                                                   // NO null-id "Other projects (N)" row anymore
  out_of_scope_project_count: number,                 // NEW top-level, ALWAYS present (0 when none)
  out_of_scope_hours: number,                         // NEW top-level, ALWAYS present (0 when none)
  timeline: [{ day, hours }],                         // unchanged
  exceptions: [{ id, type, local_date, status, details }]  // unchanged
}
```
How `out_of_scope_*` is computed: the existing per-project loop already split rows
into in-scope (pushed to `hours_by_project`) vs not-visible (accumulated into local
`otherCount` / `otherHours`). The only change is that the not-visible bucket is no
longer pushed as a synthetic `{ project_id: null, project_name: 'Other projects (N)', hours }`
row — instead it surfaces as `out_of_scope_project_count = otherCount` and
`out_of_scope_hours = Number(otherHours.toFixed(2))`, emitted unconditionally (0/0
when the actor's scope covers everything, or when the actor is RBAC-unrestricted so
`visibleSet === null`). The F3.2 privacy intent (don't reveal names/ids of projects
the actor can't see) is preserved — the count+hours are aggregate, non-identifying.

## Project rollup — `GET /v1/reports/projects/:projectId/rollup` (emitted shape, EXACT)
```
{
  project: { id, name, client_name, billing_mode, fixed_fee_amount, currency, hours_budget },  // unchanged
  date_range: { from, to },                           // unchanged
  total_hours: number,                                // unchanged
  billable_hours: number,                             // NEW top-level, ALWAYS present (0 when none)
  hours_by_member: [{ user_id, display_name, hours }],// unchanged
  hours_by_task: [{ task_id, task_name, hours }],     // unchanged
  budget: { ... } | null                              // unchanged
}
```
How `billable_hours` is computed: added a second aggregate column to the EXISTING
total-hours query (not a new query — avoids N+1) mirroring the team-dashboard /
profitability pattern:
`COALESCE(SUM(CASE WHEN te.billable THEN EXTRACT(EPOCH FROM (te.end_at - te.start_at))/3600.0 ELSE 0 END), 0)::numeric(10,2) AS billable_hours`.
It inherits the SAME RBAC user-filter (`totalUserFilter` / `totalParams`) and
date-range/`end_at IS NOT NULL` predicates as `total_hours`, so `billable_hours` is
always a subset of `total_hours` over the identical filtered set. Coerced with
`Number(totalRows[0]?.billable_hours ?? 0)`.

## Consumers
- The drill-in pages `/dashboard/employees/:id` and `/dashboard/projects/:id` are the
  SOLE consumers of these two endpoints, so the reshape is non-breaking elsewhere.
  frontend-dev should read `out_of_scope_project_count`/`out_of_scope_hours` and
  `billable_hours` from the top level; the FE must NOT expect a null-id row in
  `hours_by_project` anymore. api-designer's openapi.yaml + contract tests must pin
  these exact shapes.

# Open questions / unknowns
- None. The reshape is mechanical (no SQL semantics changed for existing fields;
  out_of_scope numbers equal what was previously folded into the synthetic row).

# Verification evidence
- `pnpm --filter @harvoost/api test` → 40 files / **313 passed (313)**, 0 failed.
  Baseline was 310; +3 net new tests (employee zero-out-of-scope case, project
  billable_hours subset case, project zero-billable case). The pre-existing
  "Other projects (N)" assertion was rewritten in place (not added) to assert the
  new shape: `hours_by_project` has no `project_id: null` row and
  `out_of_scope_project_count`/`out_of_scope_hours` are top-level numbers equal to
  the previously-folded values (2 projects / 5 hours), plus the 0/0 case.
- `pnpm --filter @harvoost/api typecheck` → clean (tsc --noEmit, no output).
