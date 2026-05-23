---
phase: incidents/INC-004
agent: api-designer
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Brought `03-api-design/openapi.yaml` in line with the INC-004 pinned contract (added the
two missing GET report dashboards, the cost-rates + billable-rates resource pairs, a reusable
`date_range` query param, and four reusable row/resource schemas; verified the schedules
dashboard + schedule-override POST were already correct), and built a build-time,
OpenAPI-driven FE↔BE contract test under `tests/contract/` that statically asserts every
`apps/web` `apiFetch()` call maps to a declared spec operation AND a registered NestJS route,
that FE query keys are declared params, and that the load-bearing endpoints' response schemas
declare the exact fields the FE reads. The test is the durable fix for the M7
"frontend-invented-endpoints" drift class and would have caught all of Rows 1-5.

# Files touched
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml` (modified)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.patch.yaml` (new; non-authoritative empty placeholder — see note below, safe to delete)
- `tests/contract/package.json` (new)
- `tests/contract/tsconfig.json` (new)
- `tests/contract/vitest.config.ts` (new)
- `tests/contract/src/paths.ts` (new)
- `tests/contract/src/walk.ts` (new)
- `tests/contract/src/scan-frontend.ts` (new)
- `tests/contract/src/scan-backend.ts` (new)
- `tests/contract/src/load-spec.ts` (new)
- `tests/contract/src/schema-fields.ts` (new)
- `tests/contract/src/contract-spec.ts` (new — pinned-contract expectations + debt allowlists)
- `tests/contract/src/contract.test.ts` (new — the test)
- `pnpm-workspace.yaml` (modified — added `tests/contract` to the workspace)

## openapi.yaml changes, per pinned-contract row
- **Row 1 — `GET /v1/reports/team-dashboard`** (was ABSENT): added. Query `date_range`
  (`YYYY-MM-DD/YYYY-MM-DD`, required, via new `DateRange` param). Response
  `{ items: TeamDashboardRow[], scope_meta }` (hours-only, NO cost columns). Description notes
  the manager-scope RBAC + the `items` (not `data`) envelope. New schema `TeamDashboardRow`
  (`user_id, display_name, total_hours, hours_by_project[], missed_punch_count, overtime_count`
  + optional `billable_hours`/`non_billable_hours`).
- **Row 2 — `GET /v1/reports/profitability`** (was ABSENT): added. Query `date_range` (required).
  Response `{ items: ProfitabilityRow[], scope_meta? }`. Marked Admin/FinMgr-only in the
  description ("MUST NOT be widened"). New schema `ProfitabilityRow` (`project_id, project_name,
  client_name?, billing_mode, hours, billable_hours, revenue, cost, margin, margin_pct, currency`)
  — uses the FE field names `project_name`/`hours` (not the backend-internal `name`/`hours_total`).
- **Row 3 — `GET /v1/schedules/dashboard`**: VERIFIED unchanged. Params (`tab`,`user_id`,
  `date_from`,`date_to`,`group_by`) and `ScheduleDashboardRow` already match the BE/FE exactly.
- **Row 3b — `POST /v1/schedules/overrides`**: VERIFIED + hardened. `CreateScheduleOverrideRequest`
  already used the authoritative shape (`effective_from`/`effective_to`/`start_time`/`end_time`/
  `user_id`/`project_id`/lunch/`reason`); added a description making it explicit the legacy
  `date_range`/`new_start`/`target_id` form is retired and the example now includes lunch fields.
- **Row 4 — `/v1/cost-rates`** (was ABSENT): added `GET` (query `current`,`user_id`,`page`,
  `page_size`; response `OffsetPaginated<CostRate>` = `{ data, page, page_size, total_count }`)
  and `POST` (body `{ user_id, rate, currency, effective_from }`, 201 → `CostRate`; documented
  409/422 on overlapping effective range). Admin/FinMgr-only. New schemas `CostRate`
  (`id?, user_id, rate, currency, effective_from, effective_to, created_by, created_at`) +
  `CreateCostRateRequest`.
- **Row 5 — `/v1/billable-rates`** (was ABSENT): added `GET` (query `current`,`project_id`,`page`,
  `page_size`; response `OffsetPaginated<BillableRate>`) and `POST` (body `{ project_id, task_id?,
  rate, currency, effective_from }`, 201 → `BillableRate`; 409/422 on overlap). Admin/FinMgr-only.
  New schemas `BillableRate` (`id?, project_id, task_id, task_name?, rate, currency,
  effective_from, effective_to, created_by, created_at`) + `CreateBillableRateRequest`.
- Also: added a `Rates` tag, a reusable `DateRange` query parameter, and updated the info-block
  pagination/cost-stripping prose to mention cost_rates/billable_rates + the GET dashboards.
  Reused existing conventions throughout (`OffsetPaginationMeta` allOf, `ScopeMeta`, the standard
  `BadRequest/Unauthorized/Forbidden/ValidationFailed` responses, `bearerAuth`).

# What downstream agents need to know
- **Contract test command (orchestrator runs this AFTER all lanes land + the stack rebuilds):**
  `pnpm --filter @harvoost/contract test`
  It is a pure static test (no running stack, no DB) — it reads files off disk: the pinned
  `openapi.yaml`, `apps/web/**` for `apiFetch` calls, and `apps/api/src/**/*.controller.ts` for
  registered routes. It is also picked up by the existing `pnpm test` / `turbo run test` task
  (the package exposes a standard `test` script), so no `turbo.json` change was needed.
  First run requires `pnpm install` so the new package's deps (`vitest`, `yaml`) resolve.
- **What the test asserts (4 layers):** (1) every unique FE `apiFetch` `{method, path-template}`
  is a declared `openapi.yaml` operation; (2) it is also a registered NestJS route (the 404
  guard — this is what catches Rows 3/4/5's missing controllers); (3) FE query keys ⊆ the
  operation's declared query params; (4) for the load-bearing set (team-dashboard, profitability,
  schedules/dashboard, cost-rates GET+POST, billable-rates GET+POST) the spec's 2xx response
  schema declares every field the FE reads at the right envelope key (`items` vs `data`,
  `project_name`/`hours`) — the exact drift that left Rows 1-2's tables empty.
- **Verified live during this task that the other two lanes have ALREADY landed** their changes:
  `apps/web/app/{dashboard,financial}/page.tsx` now send `date_range`; `apps/api/src` now has
  `cost-rates`, `billable-rates` controllers + a `schedules @Get('dashboard')`. So with my spec
  edits the test should go fully green for all five rows. I could not run it (no Bash); the
  orchestrator must run it.
- **Two documented out-of-scope allowlists in `tests/contract/src/contract-spec.ts`** keep the
  suite green for INC-004 while leaving real debt visible in the test log (printed by the
  "enumeration (informational)" test):
  - `KNOWN_SPEC_GAP`: `GET /v1/reports/{projects,employees}/{id}/rollup` — backend routes exist
    and the dashboard drill-in pages consume them, but they are NOT in openapi.yaml and NOT in
    HOTFIX_PLAN. Spec-declaration check relaxed (route-existence still enforced).
  - `KNOWN_ROUTE_GAP`: `POST /v1/time-entries/{id}/submit` — declared in the spec and called by
    `timesheets/page.tsx`, but the time-entries controller registers no `:id/submit` route. This
    is a genuine LATENT 404 (M7 class) outside INC-004 scope — recommend a follow-up incident.
  - `KNOWN_PARAM_DRIFT`: `start_at_from/start_at_to` on `GET /v1/time-entries`, `stage` on
    `GET /v1/approvals/queue`, `mine` on `GET /v1/leave/requests` — pre-existing param drift on
    pages no INC-004 lane touches.
- **Decision worth logging:** I did NOT fold the two report drill-in rollup endpoints into the
  spec (kept them as documented `KNOWN_SPEC_GAP`) to stay inside the INC-004 pinned scope rather
  than expand the contract. If the orchestrator prefers the spec be complete, adding those two
  GET operations is a small, mechanical follow-up.
- `openapi.patch.yaml` is an empty placeholder I created early and then neutralised; all real
  changes are inline in `openapi.yaml`. It can be deleted.

# Open questions / unknowns
- The contract test was authored but NOT executed (this agent has no Bash). The orchestrator
  must run `pnpm --filter @harvoost/contract test` after the stack rebuild. If the FE regex scan
  surfaces a call site I could not statically resolve, it is reported (non-fatal) in the
  "unresolved" list; a `/v1` path that fails to parse is a hard failure by design.
- If `openapi.yaml` is later relocated out of the run folder to a stable repo path, add that path
  to `SPEC_CANDIDATES` in `tests/contract/src/paths.ts` (it already probes `03-api-design/` and
  `docs/openapi.yaml` as fallbacks).

# Verification evidence
- Static cross-check (Grep) of every FE `apiFetch` call site vs the new spec operations vs the
  registered NestJS `@Controller`+`@Get/@Post/...` routes: all five pinned rows now line up
  (path + method + the load-bearing read-fields). team-dashboard→`@Get('team-dashboard')`,
  profitability→`@Get('profitability')`, schedules/dashboard→`@Get('dashboard')`,
  cost-rates→`@Controller('v1/cost-rates')`+`@Get()`/`@Post()`,
  billable-rates→`@Controller('v1/billable-rates')`+`@Get()`/`@Post()`.
- `$ref` resolution check (Grep): every new `$ref` (`TeamDashboardRow`, `ProfitabilityRow`,
  `CostRate`, `CreateCostRateRequest`, `BillableRate`, `CreateBillableRateRequest`, `DateRange`)
  resolves to a definition present in the file.
- Test execution: NOT run here (no Bash) → orchestrator to run `pnpm --filter @harvoost/contract test`.
