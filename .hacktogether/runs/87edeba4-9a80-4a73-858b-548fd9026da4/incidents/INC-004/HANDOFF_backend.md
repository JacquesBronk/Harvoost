---
phase: incidents/INC-004
agent: backend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Implemented the backend lane of hotfix INC-004 (frontend↔backend endpoint drift)
across `apps/api` only. Aligned the two report envelopes/field names (Rows 1-2),
implemented the spec'd `GET /v1/schedules/dashboard` (Row 3), re-shaped the
create-override POST contract to the spec/FE shape (Row 6), and added the two
missing rate controllers `CostRatesController` + `BillableRatesController`
(Rows 4-5) against the pre-existing tables/helpers. NO new migration. All RBAC
gates preserved/added per the canonical contract. 44 INC-004 backend tests pass;
api typecheck clean.

# Files touched
- apps/api/src/reports/reports.controller.ts (modified) — Rows 1 & 2
- apps/api/src/schedules/schedules.controller.ts (modified) — Rows 3 & 6
- apps/api/src/cost-rates/cost-rates.controller.ts (new) — Row 4
- apps/api/src/cost-rates/cost-rates.module.ts (new) — Row 4
- apps/api/src/billable-rates/billable-rates.controller.ts (new) — Row 5
- apps/api/src/billable-rates/billable-rates.module.ts (new) — Row 5
- apps/api/src/app.module.ts (modified) — register the two new modules
- apps/api/test/unit/reports-dashboard-endpoints.test.ts (modified) — items/field renames
- apps/api/test/unit/schedule-overrides-broad.test.ts (modified) — new POST shape
- apps/api/test/unit/schedules-dashboard.test.ts (new) — Row 3 coverage
- apps/api/test/unit/cost-rates-controller.test.ts (new) — Row 4 coverage
- apps/api/test/unit/billable-rates-controller.test.ts (new) — Row 5 coverage

# Exact final contract implemented (per row — for api-designer + frontend-dev cross-check)

## Row 1 — GET /v1/reports/team-dashboard
- Reads `?date_range=YYYY-MM-DD/YYYY-MM-DD` (unchanged; 400 `VALIDATION_FAILED` on bad value).
- Response envelope key renamed `data` → **`items`**: `{ items: TeamDashboardRow[], date_range, scope_meta }`.
- Row fields unchanged: `user_id, display_name, total_hours, billable_hours, non_billable_hours, hours_by_project[], missed_punch_count, overtime_count`.
- `scope_meta` preserved exactly as before (`visible_users`/`visible_projects`; `'all'` sentinel when unrestricted — NOT changed to `-1`, to honor "preserve scope_meta"). HOURS-only, no cost columns.
- RBAC unchanged: `getVisibleUserIds`/`getVisibleProjectIds` intersection.

## Row 2 — GET /v1/reports/profitability
- Reads `?date_range=YYYY-MM-DD/YYYY-MM-DD` (required; FE now sends current-month default). `group_by`/`limit` still ignored.
- Response envelope key renamed `data` → **`items`**: `{ items: FinancialProjectRow[], date_range }`.
- Row field renames: `name` → **`project_name`**, `hours_total` → **`hours`**. All other fields unchanged (`project_id, billing_mode, currency, revenue, cost, margin, margin_pct, billable_hours, billing_mode_breakdown`).
- RBAC unchanged & NOT widened: `@Roles('admin','finmgr')` stays.

## Row 3 — GET /v1/schedules/dashboard (NEW route, spec-conformant)
- Params: `tab` (company|team|individual, required), `user_id?`, `date_from` (date, required), `date_to` (date, required), `group_by?` (accepted, not re-shaping).
- Response: `{ data: ScheduleDashboardRow[], scope_meta }` (FE reads `.data` here — matches spec).
- Row: `user_id, user_display_name, local_date, scheduled_start (HH:MM), scheduled_end (HH:MM), scheduled_hours (number, minus lunch), source, override_reason`.
- `source` values: **`template` | `user_override` | `org_override`** — see "INTERPRETATION" below.
- RBAC: `tab=company` → Admin/FinMgr only (403 otherwise); `tab=team` → `getVisibleUserIds` scope (empty scope ⇒ empty grid, not error); `tab=individual` → requires `user_id`, `assertCanSeeUser` 403 unless in scope (self-request skips the assert). Rows emitted only on the user's template `working_days`. No cost columns.

## Row 6 — POST /v1/schedules/overrides (re-shaped to spec/FE)
- New Zod `.strict()` body: `{ scope, user_id?, project_id?, effective_from, effective_to, start_time?, end_time?, lunch_start_time?, lunch_end_time?, reason? }`. Only `scope`/`effective_from`/`effective_to` required (per spec). Times optional (DB columns are nullable).
- Maps to columns `user_id`/`project_id`/`effective_from`/`effective_to`/`start_time`/`end_time`/`lunch_start_time`/`lunch_end_time`/`reason`/`created_by`.
- Scope gate preserved: scope=user → manager-in-scope (`assertCanSeeUser`) or admin/finmgr, `user_id` required; scope=project → admin/finmgr only, `project_id` required; scope=org → admin/finmgr only, no target.
- GiST `23P01` (`so_no_overlap`) → clean `ValidationFailedError` (code `SCHEDULE_OVERRIDE_CONFLICT`), same as before.
- Response is now the full `ScheduleOverride` (id, scope, user_id, project_id, effective_from/to, start/end/lunch times as HH:MM, reason, created_by, created_at) instead of `{ id, scope }`.

## Row 4 — GET/POST /v1/cost-rates (NEW CostRatesController, NO migration)
- `@Roles('admin','finmgr')` on the whole controller.
- `GET ?current=true&page&page_size` → current rate per user (`effective_from <= CURRENT_DATE AND (effective_to IS NULL OR > CURRENT_DATE)`). `current` defaults ON.
- `GET ?user_id=&page&page_size` → that user's full history (newest first).
- `POST {user_id, rate, currency, effective_from}` → end-dates the prior open row (in a txn), inserts a new effective-dated row, sets `created_by` from the actor, records `cost_rate.create` audit. GiST `23P01` (`ecr_no_overlap`) → `ValidationFailedError` (code `COST_RATE_CONFLICT`).
- Response: `OffsetPaginated<CostRate>` = `{ data, page, page_size, total_count }`. Row: `id, user_id, user_display_name?, rate, currency, effective_from, effective_to, created_by, created_at`.

## Row 5 — GET/POST /v1/billable-rates (NEW BillableRatesController, NO migration)
- `@Roles('admin','finmgr')` on the whole controller.
- `GET ?current=true&page&page_size` → current rate per project + per-task rows (FE treats `task_id == null` as the project default). `GET ?project_id=&page&page_size` → that project's history.
- `POST {project_id, task_id?, rate, currency, effective_from}` → end-dates the prior open row for the same `(project_id, task_id)` tuple (`task_id IS NOT DISTINCT FROM` so the project-default row matches itself), inserts, sets `created_by`, records `billable_rate.create` audit. GiST `23P01` (`pbr_no_overlap`) → `ValidationFailedError` (code `BILLABLE_RATE_CONFLICT`).
- Response: `OffsetPaginated<BillableRate>` = `{ data, page, page_size, total_count }`. Row: `id, project_id, project_name?, task_id, task_name?, rate, currency, effective_from, effective_to, created_by, created_at`.

# What downstream agents need to know
- NO migration was written or needed. The tables (`employee_cost_rates`, `project_billable_rates`, `schedule_overrides`, `schedule_templates`), GiST exclusions (`ecr_no_overlap`, `pbr_no_overlap`, `so_no_overlap`) and helper fns all pre-exist (init migration). I validated the end-date+insert+overlap behavior directly against the LIVE DB inside a rolled-back txn (see evidence).
- **INTERPRETATION (flag for api-designer):** HOTFIX_PLAN.md Row 3 abbreviates `source` as `template|override`, but BOTH the canonical `openapi.yaml` `ScheduleDashboardRow.source` enum AND the FE `ScheduleDashboardRow` type use `template | user_override | project_override | org_override`. I implemented the spec/FE enum (emitting `template`, `user_override`, `org_override`; `project_override` is reserved/unused — see next bullet). The FE renders any `source !== 'template'` as an override block, so this is FE-compatible.
- **Project-scope overrides are NOT applied in the per-user/day dashboard grid.** A project-scope override has no single project dimension in a per-user/day cell, so the grid composes user-scope > org-scope > template only. `project_override` therefore never appears from this route. If product wants project-scope shading per user, that needs a project-membership join + a grouping decision — out of scope for this hotfix.
- **RBAC conflict status code:** all three GiST `23P01` mappings use `ValidationFailedError` (HTTP 400, code `*_CONFLICT` in `details`) — this mirrors the existing `SchedulesController` pattern exactly ("like SchedulesController does"), rather than a literal 409. The FE `describeError` handles the structured `code` fine. If a hard 409 is preferred, swap to a 409 DomainError uniformly across all three (and SchedulesperColumns) in a follow-up.
- `GET /v1/schedules/overrides` LIST endpoint still uses the legacy `target_id` query param — left untouched because the FE schedule page does NOT call the list endpoint (only the POST), and it's outside the INC-004 row set.
- The running `harvoost-api` container predates these changes; it needs a rebuild/redeploy to expose the new routes (deployment handled outside this lane).

# Open questions / unknowns
- **Cross-lane test race (NOT a backend defect):** the suite-level run shows 1 failing test, `apps/api/test/unit/openapi-contract.test.ts` → "the frontend-invented endpoints (NOT in openapi.yaml) are flagged as integration gaps". This assertion expects `/v1/reports/team-dashboard` + `/v1/reports/profitability` to be ABSENT from `openapi.yaml`. The **api-designer lane** (running in parallel) has now ADDED those operations to the spec (openapi.yaml:1965, 2030), so the assertion trips. `openapi.yaml` and that spec-presence assertion are owned by api-designer (I am forbidden from touching the spec). **Action for orchestrator/api-designer:** update or remove that stale assertion in `openapi-contract.test.ts` now that the report endpoints are deliberately in the spec. All 44 INC-004 backend tests pass independently of this.

# Verification evidence
- `pnpm --filter @harvoost/api typecheck` → PASS (tsc --noEmit, no errors).
- INC-004 backend tests (`vitest run` on the 5 relevant files) → **44 passed (5 files)**: reports-dashboard-endpoints (10), schedule-overrides-broad (11), schedules-dashboard (13), cost-rates-controller (5), billable-rates-controller (5).
- Full suite `pnpm --filter @harvoost/api test` → 257 passed / 1 failed (258). The single failure is the cross-lane `openapi-contract.test.ts` spec-presence assertion described above (api-designer-owned), NOT backend code. (Pre-change baseline of this suite was green; the failure appeared only after the parallel spec edit landed.)
- Live DB validation (rolled back, seed untouched): `employee_cost_rates` current-per-user query returns one row per user; end-date prior open row + insert new effective-dated row succeeds (half-open `[)` range, no self-overlap); an overlapping insert raises `ecr_no_overlap` SQLSTATE `23P01` → mapped to clean conflict. `project_billable_rates` `task_id IS NOT DISTINCT FROM NULL` end-dating matches exactly the project-default row.
- NO migration added (confirmed: no files under `packages/db/prisma/migrations/` touched). RBAC gates intact: profitability + both rate controllers `@Roles('admin','finmgr')`; schedules/dashboard company-tab admin/finmgr-only, team/individual scoped; override POST scope gate preserved. INC-003 `@SkipThrottle({ auth: true })` on `/me` and INC-001/002 fixes untouched.
