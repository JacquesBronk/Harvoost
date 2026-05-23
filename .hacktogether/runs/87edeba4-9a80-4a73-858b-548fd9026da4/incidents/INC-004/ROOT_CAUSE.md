# INC-004 — Root Cause (frontend↔backend endpoint drift)

GitHub issue #4. M7 "frontend-invented endpoints" class. Confirmed: **YES** — all
five mismatches reproduced live with a real Keycloak session. Two of the five
behave differently from the issue audit in a way that changes the fix-direction
recommendation (see Rows 1 and 3). One additional latent mismatch found (Row 6).

Live evidence captured under `repro/out/` (curl-equivalent browser-context
fetches + a browser symptom pass), signed in via the real OIDC handshake
(`signInAs`, `E2E_LIVE=1`). Sessions: Alice (manager) for rows 1/3; Bootstrap
Admin for rows 2/4/5 (financial + rate pages are Admin/FinMgr-gated).

## Symptoms
Signed in as a privileged user, four role-specific pages render their failure
state instead of data:

| Page | Failing request (live) | Status | Rendered text |
|------|------------------------|--------|---------------|
| `/dashboard` | `GET /v1/reports/team-dashboard?start_at_from=…&start_at_to=…` | **400** | "Could not load data. Please check the form and try again." |
| `/financial` | `GET /v1/reports/profitability?group_by=project&limit=100` | **400** | "Could not load data. Please check the form and try again." |
| `/schedule` | `GET /v1/schedules/dashboard?tab=…&date_from=…&date_to=…` | **404** | "Could not load data. The item you are looking for could not be found." |
| `/admin/rates` (Cost) | `GET /v1/cost-rates?current=true&…` | **404** | "Could not load data. An internal error occurred." |
| `/admin/rates` (Billable) | `GET /v1/billable-rates?current=true&…` | **404** | "Could not load data." |

(The FE friendly-error map turns the 404 `NOT_FOUND` envelope into "item not
found" for `/schedule`, but the rate 404s come back as NestJS's default
not-found body without a `code`, so `api-client.ts` falls back to
`UNKNOWN_ERROR` → "An internal error occurred". Cosmetic, same root cause.)

## Canonical-spec verdict (drives the fix-direction)
The canonical contract is `03-api-design/openapi.yaml`. Checked each row against it:

- The spec's **Reports** section defines ONLY `POST /v1/reports/detailed-activity`
  and `POST /v1/reports/time-rollup`. It defines **neither** `team-dashboard`
  **nor** `profitability` (GET or POST). So for Rows 1 & 2 the spec is **silent**:
  *both* the FE call and the BE route are off-spec inventions. Neither side "owns"
  the contract via the spec — pick the lowest-churn alignment.
- The spec **does** define `GET /v1/schedules/dashboard` (openapi.yaml:1460-1508)
  with exactly `tab` (enum company|team|individual), `user_id`, `date_from`
  (`format: date`), `date_to` (`format: date`), `group_by`. The **frontend matches
  the spec precisely**; the **backend is the drifted side** (route absent). This
  flips the issue's "implement vs repoint" framing — implementing the route is the
  spec-conformant fix, not just the higher-effort option.
- The spec defines **no** `cost-rates` / `billable-rates` paths (Rows 4 & 5 are
  spec-silent — a known v1.0.1 deferral, see api-types.ts:310-316 and the
  rates page TODO at admin/rates/page.tsx:42-46).

## Per-row detail

### Row 1 — `/dashboard` → team-dashboard (400)
- **FE call:** `apps/web/app/dashboard/page.tsx:60-67` →
  `apiFetch('/v1/reports/team-dashboard', { query: { start_at_from, start_at_to } })`
  with **ISO-8601 timestamps** (e.g. `2026-05-18T00:00:00.000Z`). Expects
  `ScopedList<TeamDashboardRow>` = `{ items, scope_meta }`.
- **BE contract:** `apps/api/src/reports/reports.controller.ts:113-118` —
  `@Get('team-dashboard')` reads a single `@Query('date_range')` and requires
  `YYYY-MM-DD/YYYY-MM-DD` (regex at line 20; `parseDateRange` throws
  `ValidationFailedError` otherwise). Returns `{ data, date_range, scope_meta }`.
- **Spec:** silent (no team-dashboard).
- **Live:** FE-shape → `400 {"code":"VALIDATION_FAILED","message":"date_range
  must be in the form YYYY-MM-DD/YYYY-MM-DD","details":{"date_range":null}}`.
  BE-contract (`date_range=2026-05-18/2026-05-25`) → `200 {"data":[],"date_range":
  {…},"scope_meta":{"visible_users":3,"visible_projects":2}}`.
- **Matches the audit?** YES on the 400 + param mismatch. **Plus a second drift
  the audit did not flag:** even with the param fixed, the FE reads `.items` but
  the BE returns `.data` (envelope mismatch) and `TeamDashboardRow` omits
  `billable_hours`/`non_billable_hours` the BE sends (harmless). So the param fix
  alone is necessary but not sufficient for the table to populate — the envelope
  (`items` vs `data`) must align too.

### Row 2 — `/financial` → profitability (400)
- **FE call:** `apps/web/app/financial/page.tsx:52-59` →
  `apiFetch('/v1/reports/profitability', { query: { group_by:'project', limit:100 } })`
  — **no date_range**. Expects `Paginated<FinancialProjectRow>` = `{ items }` with
  `project_name`, `hours`.
- **BE contract:** `reports.controller.ts:256-259` — `@Roles('admin','finmgr')
  @Get('profitability')` requires `@Query('date_range')`; ignores `group_by`/`limit`.
  Returns `{ data, date_range }` with `name` (not `project_name`) and `hours_total`
  (not `hours`).
- **Spec:** silent (no profitability).
- **Live:** FE-shape → `400 VALIDATION_FAILED` (`date_range: null`). BE-contract
  (`date_range=2026-05-01/2026-05-31`, as admin) → `200` with 4 real project rows
  (Pegasus fixed-fee margin 100%, Atlas 8h, etc.). RBAC gate confirmed working
  (admin reached it; a manager would 403).
- **Matches the audit?** YES on the 400 + missing date_range. **Plus envelope/field
  drift** (`items`/`project_name`/`hours` vs `data`/`name`/`hours_total`) — same
  note as Row 1: the param fix alone won't render the table.

### Row 3 — `/schedule` → schedules/dashboard (404)
- **FE call:** `apps/web/app/schedule/page.tsx:285-297` →
  `apiFetch('/v1/schedules/dashboard', { query: { tab, user_id, date_from, date_to } })`.
  Expects `{ data: ScheduleDashboardRow[] }`.
- **BE reality:** `apps/api/src/schedules/schedules.controller.ts` exposes only
  `me`, `me` (PATCH), `users/:id`, `overrides` (GET/POST), `overrides/:id` (DELETE).
  **No `dashboard` route.** NestJS returns a default 404.
- **Spec:** **DEFINES this route** (openapi.yaml:1460-1508) with the exact param
  set the FE sends. **FE matches spec; BE drifted.**
- **Live:** FE-shape → `404 {"code":"NOT_FOUND","message":"Cannot GET
  /v1/schedules/dashboard…"}`.
- **Matches the audit?** YES on the 404. **Correction:** the audit framed this as
  "implement (more work) vs repoint (less work, may lose tabs)". Because the spec
  is decisive (the FE is correct), **implementing the route is the spec-conformant
  fix**; repointing would put the FE off-spec.

### Row 4 — Admin › Rates → cost-rates (404)
- **FE call:** `apps/web/app/admin/rates/page.tsx:141,152,370` →
  `GET /v1/cost-rates` (list `current=true`; history `user_id=…`) and
  `POST /v1/cost-rates` (set rate). Expects `OffsetPaginated<CostRate>` =
  `{ data, page, page_size, total_count }`.
- **BE reality:** grep confirms **no `@Controller('v1/cost-rates')`** anywhere in
  `apps/api/src`. NestJS 404.
- **Spec:** silent.
- **Live:** `404 {"code":"NOT_FOUND","message":"Cannot GET /v1/cost-rates…"}`.
- **Matches the audit?** YES. **Data layer confirmed present:** table
  `employee_cost_rates` exists (migration `20260522000000_init` lines 163-177)
  with `(user_id, rate, currency, effective_from, effective_to, created_by)` and an
  `ecr_no_overlap` GiST exclusion; helper `get_effective_cost_rate(user_id, date)`
  exists (init migration line 571); seed populates current rates
  (`packages/db/prisma/seed.ts:230-249`). **No new migration needed.**

### Row 5 — Admin › Rates → billable-rates (404)
- **FE call:** `admin/rates/page.tsx:432,445,674` → `GET /v1/billable-rates`
  (list/history) + `POST /v1/billable-rates`. Expects `OffsetPaginated<BillableRate>`.
- **BE reality:** **no `@Controller('v1/billable-rates')`**. NestJS 404.
- **Spec:** silent.
- **Live:** `404 {"code":"NOT_FOUND","message":"Cannot GET /v1/billable-rates…"}`.
- **Matches the audit?** YES. **Data layer present:** table
  `project_billable_rates` (init migration lines 144-160) with
  `(project_id, task_id, rate, currency, effective_from, effective_to, created_by)`
  + `pbr_no_overlap` GiST exclusion; helper
  `get_effective_billable_rate(project_id, task_id, date)` (init migration line 582);
  seed populates rates (`seed.ts:189-208`). **No new migration needed.**

### Row 6 (NEW — latent, not in the issue audit) — Schedule "New override" POST
- **FE call:** `schedule/page.tsx:91-97,122-140` →
  `POST /v1/schedules/overrides` with body
  `{ scope, user_id, project_id, effective_from, effective_to, start_time,
     end_time, lunch_start_time, lunch_end_time, reason }`
  (FE type `CreateScheduleOverrideRequest`, api-types.ts:285-296).
- **BE contract:** `schedules.controller.ts:37-55` — `CreateOverrideSchema` is a
  Zod `.strict()` object expecting a **different shape**:
  `{ scope, target_id, date_range:{start,end}, new_start, new_end,
     new_lunch:{start,end}, reason }`. The FE body would be rejected:
  `effective_from`/`start_time`/`user_id` are unknown keys (strict) and the
  required `date_range`/`new_start`/`new_end`/`reason(min1)` are absent →
  **422/400** the moment a privileged user submits the modal.
- **Spec:** openapi.yaml's `CreateScheduleOverrideRequest` uses the FE shape
  (`effective_from`/`effective_to`/`start_time`/`user_id` — see the create-override
  example at openapi.yaml:1418-1426). **FE matches spec; BE drifted.**
- **Status:** NOT reproduced via curl (it's a POST mutation; I avoided writing
  data), confirmed by static contract read. The Schedule page is already broken by
  Row 3 (the dashboard GET 404s before the user can open the modal), so this is
  latent behind Row 3 but must be fixed together for `/schedule` to fully work.

## Root Cause
**Frontend pages were built ahead of (and never reconciled with) the backend, and
the backend in turn drifted from the canonical OpenAPI spec.** The Reports
controller invented a GET `date_range` contract that no layer's spec sanctions
(Rows 1-2); the Schedules controller never implemented the spec'd
`GET /v1/schedules/dashboard` and shipped a POST-override shape that diverges from
the spec (Rows 3, 6); the cost/billable rate controllers were deferred to v1.0.1
but the admin UI shipped against their intended paths anyway (Rows 4-5). On top of
the path/param drift there is **response-envelope drift** (`items` vs `data`,
`project_name` vs `name`, `hours` vs `hours_total`) on the report rows.

**Systemic cause:** there is **no FE↔BE contract test**. The hermetic e2e suite
mocks the API origin (`tests/e2e/fixtures/mock-api.ts`) so the FE talks to a
fixture, not the real routes; the live e2e lane only exercises the OIDC handshake
+ `/timesheets`. Nothing asserts that every `apiFetch(path, {query})` resolves to a
real NestJS route with a matching param/response shape — so this entire class drifts
silently and only surfaces at manual walkthrough.

## Verification
- `repro/inc004-repro.spec.ts` (live OIDC, browser-context fetch per endpoint):
  Row1 400 / BE-contract 200; Row2 400 / BE-contract 200; Row3 404; Row4 404;
  Row5 404. Output: `repro/out/result-alice.txt`, `repro/out/result-admin.txt`,
  `repro/out/run.log`. → **2 passed (1.1m)**.
- `repro/inc004-browser.spec.ts` (admin visits each page, captures failing request
  + rendered failure UI): all four pages show the failure state with the matching
  400/404. Output: `repro/out/browser-result.txt`, `repro/out/browser-run.log`.
  → **1 passed (18.7s)**.
- Static: grep confirms no cost-rates/billable-rates controller and no
  schedules/dashboard route; schema/migrations confirm the rate tables + helpers
  exist (no migration needed).

## Prevention Recommendation
Add an **OpenAPI-driven FE↔BE contract test** (in-scope now — the durable fix for
the M7 class):
1. Enumerate every `apiFetch(path, { query, method })` call site in `apps/web`
   (static scan or a thin typed wrapper that records calls).
2. Assert each `{ method, path-template, query-keys }` resolves to (a) a declared
   operation in `03-api-design/openapi.yaml` AND (b) a registered NestJS route
   (introspect the Nest router, or hit the route table). Fail the build on any
   call that matches neither.
3. Extend it to response shape: assert the FE's expected envelope key
   (`items` vs `data`) and row field names match the spec's response schema for
   that operation. This would have caught Rows 1-2's `items`/`name`/`hours` drift
   too, not just the param/route drift.
4. Make `openapi.yaml` the single source of truth: backend route additions
   (schedules/dashboard, cost-rates, billable-rates) must add their operations to
   the spec in the same change, so the contract test stays green.
