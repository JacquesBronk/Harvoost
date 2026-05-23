---
phase: incidents/INC-004
agent: debugger
started: 2026-05-23T13:10:00Z
finished: 2026-05-23T13:35:00Z
status: complete
---

# Summary
Reproduced + confirmed all five #4 frontend↔backend endpoint mismatches with LIVE
evidence (real Keycloak OIDC sign-in via `signInAs`, browser-context fetches +
a browser symptom pass) and checked every row against the canonical
`03-api-design/openapi.yaml`. Confirmed: **YES — all 5 reproduce deterministically**
(independent of the INC-003 throttle; paced curls one-per-window, no 429 noise).
Wrote ROOT_CAUSE.md (per-row FE call / BE contract / spec verdict / live
status / audit cross-check + systemic cause) and HOTFIX_PLAN.md (per-row
recommended fix-direction + alternative + concrete files + lanes + RBAC
invariants). Did NOT touch `apps/api`/`apps/web` source; throwaway repro
specs/config + captured outputs live under `incidents/INC-004/repro/`.

# Live results (status per row)
- Row 1 `/dashboard` team-dashboard (FE ISO ts) → **400** VALIDATION_FAILED; correct `date_range=YYYY-MM-DD/YYYY-MM-DD` → **200**.
- Row 2 `/financial` profitability (FE omits date_range) → **400** VALIDATION_FAILED; correct `date_range` (as admin) → **200** with real rows.
- Row 3 `/schedule` schedules/dashboard → **404** NOT_FOUND (no route).
- Row 4 Admin›Rates cost-rates → **404** NOT_FOUND (no controller).
- Row 5 Admin›Rates billable-rates → **404** NOT_FOUND (no controller).
Browser pass: all four pages render "Could not load data" with the matching 400/404.

# Per-row fix-direction recommendation (one line each)
- Row 1: FE sends `date_range` + align envelope (`items` vs `data`) — recommend BE emits `items`. [frontend-dev + backend-dev]
- Row 2: FE sends `date_range` (default current month) + rename BE fields `name`→`project_name`,`hours_total`→`hours` + emit `items`; KEEP `@Roles('admin','finmgr')`. [frontend-dev + backend-dev]
- Row 3: IMPLEMENT `GET /v1/schedules/dashboard` (spec-conformant — FE already matches openapi.yaml; repointing would lose tabs + go off-spec). [backend-dev]
- Row 4: IMPLEMENT `CostRatesController` (table+helper+seed exist, NO migration); gate Admin/FinMgr. [backend-dev]  — alt: hide Rates page.
- Row 5: IMPLEMENT `BillableRatesController` (same, NO migration); gate Admin/FinMgr. [backend-dev] — alt: hide Rates page (joint with Row 4).
- Prevention: OpenAPI-driven FE↔BE contract test — RECOMMEND IN-SCOPE NOW. [api-designer]

# What downstream agents need to know
- **Decision-relevant correction to the issue audit (Row 3):** the canonical spec
  (openapi.yaml:1460-1508) ALREADY defines `GET /v1/schedules/dashboard` with the
  exact params the FE sends. So the FE matches the spec and the BACKEND is the
  drifted side — "implement the route" is the spec-conformant fix, not merely the
  higher-effort option. Repointing the page would push the FE off-spec.
- **Rows 1-2 spec is SILENT:** openapi.yaml's Reports section defines only
  `POST detailed-activity` + `POST time-rollup` — neither `team-dashboard` nor
  `profitability` exists in the spec (both FE call and BE GET route are off-spec
  inventions). Lowest-churn alignment recommended; fold the chosen contract into
  openapi.yaml as part of the fix.
- **Deeper than the audit (Rows 1-2):** there is ALSO response-envelope/field drift
  (`items` vs `data`; `project_name`/`hours` vs `name`/`hours_total`). The param fix
  ALONE leaves the tables empty — the envelope must align too. Plan both.
- **NEW 6th mismatch (latent):** the Schedule "New override" POST body
  (`effective_from`/`start_time`/`user_id`, matches spec) does NOT match the BE Zod
  `.strict()` `CreateOverrideSchema` (`date_range`/`new_start`/`target_id`) → it will
  422 once Row 3 is fixed. Fix WITH Row 3 (schedules.controller.ts:37-55,177-270).
- **Rows 4-5 need NO migration:** tables `employee_cost_rates` /
  `project_billable_rates` + GiST no-overlap constraints + `get_effective_cost_rate`
  / `get_effective_billable_rate` helpers + seed data all exist (init migration
  20260522000000_init; seed.ts:189-249). Only controllers + spec ops are missing.
  Note table names ≠ FE path names (`employee_cost_rates` ↔ `/v1/cost-rates`).
- **RBAC invariants (must preserve):** profitability + both rate controllers are
  Admin/FinMgr-only (cost/margin data); set `created_by` from actor + audit on POST.
  schedules/dashboard: company=Admin/FinMgr, team=RBAC scope, individual=in-scope
  user. Confirmed live the admin reached profitability (gate works).
- **Throttle note (INC-003):** all data endpoints share the global 300/60s bucket;
  I paced sign-ins one-per-60s-window and saw zero 429s — every failure was the
  deterministic 400/404, not throttle. No INC-003 regression observed.
- I removed the throwaway `tests/e2e/playwright.inc004.config.ts` after the run; a
  copy + re-run instructions are in `repro/playwright.inc004.config.ts`.

# Open questions / unknowns
- The Row 1/Row 2 envelope-and-field alignment direction (rename on BE vs adapt on
  FE) is a judgment call for the fix lane; I recommended the lower-FE-churn option.
- Whether rate management is in milestone scope at all (implement vs hide Rates) is
  a product call for HITL gate (a) — both directions documented.

# Verification evidence
- `cd tests/e2e && E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 npx playwright test --config playwright.inc004.config.ts --project=chromium-live` → 2 passed (1.1m); outputs in `repro/out/result-*.txt`, `repro/out/run.log`.
- browser pass (`inc004-browser`) → 1 passed (18.7s); output `repro/out/browser-result.txt`.
- `grep -rn "v1/cost-rates|v1/billable-rates" apps/api/src` → no matches (confirms absent controllers).
- `grep -n "@Get('dashboard')" apps/api/src/schedules` → no match (confirms absent route).
- schema/migration grep → `employee_cost_rates`/`project_billable_rates` tables + `get_effective_*` helpers present (no migration needed).
