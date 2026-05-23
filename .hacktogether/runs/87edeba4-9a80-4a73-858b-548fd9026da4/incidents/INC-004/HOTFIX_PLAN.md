# INC-004 — Hotfix Plan (fix-direction recommendations)

This is a fix-FORWARD plan (the pages have never worked against the real
backend — nothing to roll back to). For each row: RECOMMENDED direction +
ALTERNATIVE + concrete files + lane. The user picks per-row at HITL gate (a).

Suggested lanes: **backend-dev** (most rows), **frontend-dev** (param/envelope
alignment + rate response wiring), **api-designer** (fold new routes into
openapi.yaml + scope the contract test). RBAC/cost-stripping invariants flagged
inline — any new/aligned endpoint MUST preserve them.

---

## Row 1 — `/dashboard` team-dashboard param + envelope (400)
**RECOMMEND: frontend aligns to the backend param contract, AND fix the envelope
on whichever side is cheaper (recommend backend emits `items`+`scope_meta`).**
- Rationale: the spec is silent on team-dashboard, so neither side "owns" it via
  the spec. The backend already does the real RBAC-scoped aggregation work and is
  consumed only by this one page — cheapest correct alignment is to make the FE
  send what the BE reads. Param fix alone is NOT enough: the FE reads `.items`,
  the BE returns `.data` — align the envelope too or the table stays empty.
- Param fix (FE): build `date_range=YYYY-MM-DD/YYYY-MM-DD` from the local-date
  range instead of `start_at_from`/`start_at_to` ISO timestamps.
- Envelope fix: either FE reads `.data` (and add `billable_hours` etc. to the
  type) OR BE returns `{ items, scope_meta }`. Recommend BE → `items` to match the
  `ScopedList<T>` convention the FE already uses elsewhere; lower FE churn.
- Files: `apps/web/app/dashboard/page.tsx:41-67` (query param + `.items` already
  there); `apps/api/src/reports/reports.controller.ts:113-245` (rename `data`→
  `items` in the returned object) OR FE `ScopedList`→`.data`.
- ALTERNATIVE: backend accepts BOTH `date_range` and `start_at_from`/`start_at_to`
  (parse either). More BE code, keeps FE untouched; not recommended (perpetuates an
  off-spec param surface).
- Lane: frontend-dev (params) + backend-dev (envelope rename) — small.
- RBAC: backend already intersects with `getVisibleUserIds`/`getVisibleProjectIds`
  and returns `scope_meta`; preserve. team-dashboard carries hours only (no cost
  columns) — no cost-stripping concern.

## Row 2 — `/financial` profitability param + envelope/fields (400)
**RECOMMEND: frontend sends `date_range` (default to current month), AND align the
row field names (`name`→`project_name`, `hours_total`→`hours`) — recommend backend
renames to match the FE/`FinancialProjectRow` type + emits `items`.**
- Rationale: spec silent; the backend owns the real margin computation
  (`get_effective_cost_rate`/`get_effective_billable_rate`, billing-mode logic) and
  is correct — the FE just needs to ask correctly and read the right keys. The FE
  drops `group_by`/`limit` (BE ignores them); harmless.
- Files: `apps/web/app/financial/page.tsx:52-59` (add `date_range`, read `.items`);
  `apps/api/src/reports/reports.controller.ts:256-369` (return `items`; rename
  `name`→`project_name`, `hours_total`→`hours`) OR adjust `FinancialProjectRow` +
  `Paginated.items` read on the FE.
- ALTERNATIVE: backend makes `date_range` optional with a sensible default
  (e.g. current month) and keeps its own field names; FE adapts field reads. Fewer
  required FE query params but still needs the envelope/field alignment.
- Lane: frontend-dev + backend-dev — small.
- RBAC (CRITICAL): keep `@Roles('admin','finmgr')` on `profitability` — cost &
  margin are financial-only. Do NOT widen. The FE already gates the page on
  `scope.canSeeFinancialData` and the query is `enabled` only then; preserve both.

## Row 3 — `/schedule` schedules/dashboard (404)
**RECOMMEND: IMPLEMENT `GET /v1/schedules/dashboard` (the spec-conformant fix).**
- Rationale: openapi.yaml:1460-1508 already specifies this route with the exact
  params the FE sends (`tab` company|team|individual, `user_id`, `date_from`,
  `date_to` as `date`, optional `group_by`). The FE is correct; only the backend is
  missing it. Repointing the page at `overrides`/`users/:id` would push the FE
  off-spec AND lose the company/team/individual tabbed shaded-block view the page
  is built around (`ScheduleGrid`, `byUser` aggregation) — a real feature loss.
- Implementation: new `@Get('dashboard')` on `SchedulesController` that composes
  `schedule_templates` + `schedule_overrides` into per-user/day
  `ScheduleDashboardRow`s (`user_id`, `user_display_name`, `local_date`,
  `scheduled_start/end`, `scheduled_hours`, `source`, `override_reason`) for the
  date range. Return `{ data, scope_meta }` (FE reads `.data` here — matches).
- Files: `apps/api/src/schedules/schedules.controller.ts` (add the route);
  `03-api-design/openapi.yaml` is already correct (no change). FE: none for the GET.
- Effort: medium (the compose-template+overrides query is the bulk).
- Lane: backend-dev (route) + api-designer (verify spec, contract test).
- RBAC (CRITICAL): per spec — `tab=company` Admin/FinMgr only; `tab=team` returns
  the requester's RBAC scope; `tab=individual` requires `user_id` in scope (403
  otherwise). Reuse `RbacScopeService` (`getVisibleUserIds`, `assertCanSeeUser`)
  exactly as the existing override routes do. No cost columns here.

## Row 3b (Row 6) — Schedule "New override" POST shape (latent 422/400)
**RECOMMEND: align the POST body — backend accepts the spec/FE shape
(`effective_from`/`effective_to`/`start_time`/`end_time`/`user_id`/`project_id`).**
- Rationale: openapi.yaml's `CreateScheduleOverrideRequest` (and the FE) use
  `effective_from`/`effective_to`/`start_time`/`user_id`; the BE Zod
  `CreateOverrideSchema` (`.strict()`) uses `date_range:{start,end}`/`new_start`/
  `target_id`. Backend is the drifted side. Must fix WITH Row 3 or the New-override
  modal 422s the moment the page works.
- Files: `apps/api/src/schedules/schedules.controller.ts:37-55` (Zod schema) +
  `:177-270` (createOverride mapping to columns `start_time`/`end_time`/
  `lunch_start_time`/`lunch_end_time`/`user_id`/`project_id`).
- Lane: backend-dev. RBAC: preserve the existing scope gate (manager → user-scope
  in-scope only; project/org → admin/finmgr).

## Row 4 — Admin › Rates: implement `v1/cost-rates` (404)
**RECOMMEND: IMPLEMENT a `CostRatesController` (`@Controller('v1/cost-rates')`).**
- Rationale: the data layer is fully present (table `employee_cost_rates` + GiST
  no-overlap + `get_effective_cost_rate` helper + seed data) — **no migration
  needed**. The admin UI is built and only the controller is missing. Disabling the
  page defers a shipped, expected admin capability with no upside.
- Endpoints to satisfy the FE (admin/rates/page.tsx):
  - `GET /v1/cost-rates?current=true&page&page_size` → current rate per user
    (`effective_from <= today AND (effective_to IS NULL OR > today)`).
  - `GET /v1/cost-rates?user_id=&page&page_size` → that user's full history.
  - `POST /v1/cost-rates {user_id, rate, currency, effective_from}` → new
    effective-dated row (end-date the prior open row; the GiST exclusion enforces
    no overlap — map 23P01 → clean 409/422 like SchedulesController does).
  - Response envelope: `OffsetPaginated<CostRate>` = `{ data, page, page_size,
    total_count }` (FE reads `.data`). Field `user_id`, `rate`, `currency`,
    `effective_from`, `effective_to`, `created_by`, `created_at`.
- Files: NEW `apps/api/src/cost-rates/cost-rates.controller.ts` +
  `cost-rates.module.ts`; register in `apps/api/src/app.module.ts`. Add the
  operations to `03-api-design/openapi.yaml`. FE: none (already calls these paths).
- ALTERNATIVE: hide the Rates page (and `Rates` nav) until v0.2.0. Lowest effort,
  but removes a shipped admin feature; only choose if rate-management is out of
  scope for this milestone.
- Lane: backend-dev (controller) + api-designer (spec). Effort: medium.
- RBAC (CRITICAL): cost rates ARE financial data — gate the controller
  `@Roles('admin','finmgr')` (the FE page is `canSeeFinancialData`-gated; mirror it
  server-side). Do NOT expose cost rates to manager/employee. Set `created_by` from
  the actor; record an audit entry on POST (mirror SchedulesController.audit).

## Row 5 — Admin › Rates: implement `v1/billable-rates` (404)
**RECOMMEND: IMPLEMENT a `BillableRatesController` (`@Controller('v1/billable-rates')`).**
- Rationale: identical to Row 4 — table `project_billable_rates` + `pbr_no_overlap`
  GiST + `get_effective_billable_rate` helper + seed data all exist; **no migration
  needed**.
- Endpoints (admin/rates/page.tsx):
  - `GET /v1/billable-rates?current=true&page&page_size` → current rate per
    project (+ per-task rows; FE picks `task_id == null` as the project default).
  - `GET /v1/billable-rates?project_id=&page&page_size` → that project's history.
  - `POST /v1/billable-rates {project_id, task_id?, rate, currency,
    effective_from}` → new effective-dated row (end prior open row; map GiST 23P01
    → 409/422).
  - Response: `OffsetPaginated<BillableRate>` `{ data, … }` with `project_id`,
    `task_id`, `task_name?`, `rate`, `currency`, `effective_from`, `effective_to`,
    `created_by`, `created_at`.
- Files: NEW `apps/api/src/billable-rates/billable-rates.controller.ts` +
  `.module.ts`; register in `app.module.ts`. Add operations to `openapi.yaml`.
  FE: none.
- ALTERNATIVE: hide the Rates page until v0.2.0 (same as Row 4 — Rows 4 & 5 share
  the page, so the disable/implement decision is joint).
- Lane: backend-dev + api-designer. Effort: medium.
- RBAC (CRITICAL): `@Roles('admin','finmgr')`; set `created_by`; audit on POST.

## Prevention — OpenAPI-driven contract test (RECOMMEND IN-SCOPE NOW)
- A build-time test that (1) enumerates every `apps/web` `apiFetch(path,{query,
  method})` call, (2) asserts each `{method, path-template, query-keys}` maps to a
  declared `openapi.yaml` operation AND a registered NestJS route, (3) asserts the
  FE's expected response envelope/field names match the spec response schema
  (would have caught Rows 1-2's `items`/`name`/`hours` drift, not just paths).
- Files: NEW `tests/contract/` (or `packages/db/test`-style package); needs
  `openapi.yaml` to gain the schedules/dashboard + cost/billable-rates operations
  added above so the test goes green.
- Lane: api-designer (spec + test scaffold) with backend-dev/frontend-dev support.

## Rollback
All changes are additive (new controllers/routes, param+envelope alignment). If a
fix regresses:
- New controllers (Rows 3,4,5): remove the controller from its module / unregister
  from `app.module.ts` — reverts to the pre-fix 404 (page shows its failure state,
  exactly as today). No data migration to undo (tables pre-existed).
- Param/envelope edits (Rows 1,2,3b): `git revert` the specific FE/BE diff — reverts
  to the pre-fix 400/422. No schema impact.
- Each row is independently revertible; nothing shares a migration.
