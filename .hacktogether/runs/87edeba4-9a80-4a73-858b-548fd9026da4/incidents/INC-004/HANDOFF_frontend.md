---
phase: 04-build
agent: frontend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Implemented the `apps/web` frontend lane of INC-004 (FE↔BE contract drift). Aligned
the `/dashboard` and `/financial` report queries to the single inclusive local-date
`date_range=YYYY-MM-DD/YYYY-MM-DD` contract the backend reads, kept their `.items`
envelope reads, and confirmed the `/schedule` GET + override POST and the Admin ›
Rates GET/POST shapes already match the pinned contract (no request changes there —
only a stale TODO comment removed). Added 16 vitest tests pinning the query
construction (the date-range helpers + the exact URL/method/body `apiFetch` builds)
and the response-shape reads. Full web suite green (57 tests) and typecheck clean.
Touched ONLY `apps/web`; RBAC gating and the INC-001/002/003 fixes are untouched.

# Files touched
- apps/web/src/lib/tz.ts (modified) — added `dateRangeParam(from,to)` and
  `currentMonthRange(zone)` local-date helpers.
- apps/web/app/dashboard/page.tsx (modified) — Row 1: range memo now produces
  inclusive local dates; query sends `date_range` instead of `start_at_from`/
  `start_at_to`; `enabled` also guards on a non-empty range. Still reads `.items`.
- apps/web/app/financial/page.tsx (modified) — Row 2: query sends `date_range`
  defaulting to the current month (first-of-month → today); dropped `group_by`/
  `limit`. Still reads `.items` / `project_name` / `hours`. RBAC gate
  (`canSeeFinancialData` + `enabled`-only-when-financial) preserved verbatim.
- apps/web/src/lib/api-types.ts (modified) — Row 1: added optional
  `billable_hours?`/`non_billable_hours?` to `TeamDashboardRow` to match the
  backend response (not rendered today; kept optional).
- apps/web/app/admin/rates/page.tsx (modified) — Rows 4-5: removed the stale
  `TODO(post-merge): swap to generated types …` comment block. Request/response
  shapes already match the contract — no functional change.
- apps/web/__tests__/inc004-reports-query.test.ts (new) — 8 tests.
- apps/web/__tests__/inc004-rates-query.test.ts (new) — 8 tests.

# What downstream agents need to know
Cross-lane surface — the EXACT shapes `apps/web` now sends/reads (backend-dev +
api-designer must match these):

- **Row 1 — team-dashboard**: FE sends `GET /v1/reports/team-dashboard?date_range=YYYY-MM-DD/YYYY-MM-DD`
  (single param; inclusive local-date bounds — week tab = Mon..Sun, month tab =
  1st..last-of-month, in the viewer's zone). FE reads `{ items: TeamDashboardRow[], scope_meta }`.
  Rows need `user_id, display_name, total_hours, hours_by_project[{project_id,project_name,hours}],
  missed_punch_count, overtime_count`; `billable_hours`/`non_billable_hours` are
  accepted but optional/unused.
- **Row 2 — profitability**: FE sends `GET /v1/reports/profitability?date_range=YYYY-MM-DD/YYYY-MM-DD`
  (default current month = first-of-month → today). `group_by`/`limit` are NO LONGER
  sent. FE reads `{ items: FinancialProjectRow[] }` with row fields
  `project_id, project_name, client_name?, billing_mode, revenue, cost, margin,
  margin_pct, hours, currency` (`billable_hours` optional). Backend MUST emit
  `project_name`/`hours` (not `name`/`hours_total`) and `items` (not `data`).
- **Row 3 — schedules/dashboard**: NO FE CHANGE. FE already sends
  `GET /v1/schedules/dashboard?tab={company|team|individual}&user_id=&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`
  and reads `{ data: ScheduleDashboardRow[] }`. Matches openapi.yaml:1460-1508 exactly.
- **Row 3b — override POST**: NO FE CHANGE. FE already POSTs the SPEC shape to
  `/v1/schedules/overrides`: `{ scope, effective_from, effective_to, user_id?,
  project_id?, start_time?, end_time?, lunch_start_time?, lunch_end_time?, reason? }`
  (required `[scope, effective_from, effective_to]`). Matches
  `CreateScheduleOverrideRequest` (openapi.yaml:3031). Backend Zod must accept this.
- **Rows 4-5 — Admin › Rates**: NO FE REQUEST CHANGE (only the TODO comment removed).
  - cost-rates: `GET /v1/cost-rates?current=true&page=1&page_size=200`,
    `GET /v1/cost-rates?user_id=&page=1&page_size=100`,
    `POST /v1/cost-rates {user_id, rate, currency, effective_from}`. FE reads
    `OffsetPaginated<CostRate>` = `{ data, page, page_size, total_count }` with row
    fields `id, user_id, rate, currency, effective_from, effective_to, created_by,
    created_at`. NOTE: FE uses `row.id` as the list React key — backend response rows
    must include `id`.
  - billable-rates: `GET ?current=true&…`, `GET ?project_id=&…`,
    `POST {project_id, task_id?, rate, currency, effective_from}`. FE reads
    `OffsetPaginated<BillableRate>` `{ data, … }` with row fields `id, project_id,
    task_id, task_name?, rate, currency, effective_from, effective_to, created_by,
    created_at`. FE picks `task_id == null` as the project default row.

Interpretation notes (HOTFIX_PLAN ambiguity):
- `date_range` bounds are INCLUSIVE local dates (not half-open). Dashboard week =
  Mon..Sun (`start` .. `start+6d`), month = 1st..last-of-month; financial default =
  1st-of-month .. today. ROOT_CAUSE's live example `2026-05-18/2026-05-25` returned
  200 either way, so inclusivity is the FE's choice — flagging in case the backend's
  `parseDateRange` treats the upper bound as exclusive.
- Pages that needed NO change: `/schedule` (GET + override POST), and the Admin ›
  Rates request/response shapes (already contract-correct). The chosen lower-churn
  alignment (per HOTFIX_PLAN Rows 1-2 "RECOMMEND") is: FE sends `date_range`, backend
  emits `items` + renames `name`→`project_name`/`hours_total`→`hours`.

# Open questions / unknowns
- Whether the backend's `parseDateRange` treats the `date_range` upper bound as
  inclusive or exclusive (see interpretation note above). FE sends an inclusive
  upper bound; if the backend is exclusive, the last day would be dropped — backend
  lane should confirm/align.

# Verification evidence
- `pnpm --filter @harvoost/web test` → 6 files / 57 tests passed (16 new INC-004
  tests + existing INC-001 middleware, INC-002 idp-info, INC-003 auth-me-loop, avatar
  — all still green).
- `pnpm --filter @harvoost/web typecheck` → clean (tsc --noEmit, no errors).
- `pnpm --filter @harvoost/web lint` → NOT run; pre-existing `next lint` ESLint-options
  incompatibility is unrelated to this work (per dispatch instructions).
