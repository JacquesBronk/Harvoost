# Incident INC-004 — manager/admin/finance/schedule pages fail (frontend↔backend endpoint drift)

GitHub issue: [#4](https://github.com/JacquesBronk/Harvoost/issues/4) — "Manager/admin/finance/schedule pages fail to load — frontend calls missing (404) or contract-mismatched (400) API endpoints"
Surfaced during the post-INC-002 walkthrough alongside #3 (INC-003) and #5. This is the **M7 "frontend-invented endpoints"** class deferred at v0.1.0 (frontend pages built ahead of the backend, never reconciled).

## Reporter description (verbatim, condensed)
> Signed in as Alice (manager), several pages show "Could not load data" / fail outright. A full frontend↔backend audit shows the manager/admin/finance/schedule pages call endpoints whose path or query-param contract does not match the backend. Hermetic e2e mocks the API and live e2e only exercised `/timesheets`, so the drift was invisible.

## Triage (orchestrator — incident-responder skipped per user-directed hotfix flow, as in INC-001/INC-002/INC-003)
- **Severity:** sev-2 — four of the role-specific pages (manager dashboard, financial, schedule, admin rates) are unusable for real authenticated sessions; deterministic, reproducible with a single curl (independent of the #3 throttle storm, now fixed). No production impact (prod still fail-closed, v0.2.0).
- **Scope:** five endpoint mismatches across two layers. Per the issue's audit:

  | # | Page | Frontend call | Backend reality | Result | Fix-direction decision |
  |---|------|---------------|-----------------|--------|------------------------|
  | 1 | Team `/dashboard` | `GET /v1/reports/team-dashboard?start_at_from=…&start_at_to=…` (ISO ts) | reads `@Query('date_range')` `YYYY-MM-DD/YYYY-MM-DD` | **400** | align param contract — backend accepts the two ISO params OR frontend sends `date_range` |
  | 2 | Financial `/financial` | `GET /v1/reports/profitability?group_by=…&limit=…` (no date_range) | `@Query('date_range')` **required** | **400** | frontend sends the range OR backend makes `date_range` optional w/ default |
  | 3 | Schedule `/schedule` | `GET /v1/schedules/dashboard?tab=team&date_from=…&date_to=…` | no such route (`schedules` exposes only `me`, `users/:id`, `overrides`) | **404** | implement `GET /v1/schedules/dashboard` (team/individual/company) OR repoint page at existing routes |
  | 4 | Admin › Rates | `GET/POST /v1/cost-rates` | **no controller** | **404** | implement controller (seam/types exist) OR disable Rates page until it lands |
  | 5 | Admin › Rates | `GET/POST /v1/billable-rates` | **no controller** | **404** | same as #4 |

  Plus a systemic prevention: **add an OpenAPI-driven contract test** (spec at `03-api-design/openapi.yaml`) asserting every `apiFetch` path + query-param shape matches a real route, so this whole class is caught at build.
- **Reproduction:** sign in as `alice@harvoost.local` / `dev-alice-pass`, open `/dashboard`, `/financial`, `/schedule`, `/admin/rates` → each fails (400/404). Curl repros (authenticated, session cookie redacted) are in the issue.
- **Blast radius:** every manager/admin/finance user; deterministic. `/timesheets` (the only live-tested page) is unaffected.
- **Rollback recommended:** no — forward fix. The pages have never worked against the real backend (latent since v0.1.0); nothing to roll back to.

## Root cause — diagnosed in the issue with an endpoint audit (debugger REPRODUCES + CONFIRMS, does NOT re-discover)
The five mismatches above are pre-identified with file:line evidence (`apps/web/app/{dashboard,financial,schedule,admin/rates}/page.tsx` vs `apps/api/src/{reports,schedules}/*.controller.ts` and the two absent controllers). The debugger's job: **reproduce each failure live (curl with a real Alice session + a browser pass), confirm the exact contract on both sides, and lay out the fix-direction decision per row with a recommendation** — not re-derive the audit. Then write `ROOT_CAUSE.md` + `HOTFIX_PLAN.md`.

## KEY DECISIONS to surface at HITL gate (a) — before fix dispatch
For each row the team must choose **fix-forward direction**, and these have different cost/scope:
- Rows 1-2 (params): cheapest fix is usually frontend-aligns-to-backend (send `date_range`), but check whether the backend contract matches `openapi.yaml` (the canonical source) — fix the side that drifted from the spec.
- Row 3 (schedules/dashboard): implement the route (more work, matches the page's intent) vs repoint the page at existing `overrides`/`users/:id` (less work, may lose the team/company tabs).
- Rows 4-5 (rate controllers): implement two new controllers (the architecture/types seam exists per `apps/web/app/admin/rates/page.tsx:42-44` TODO) vs disable the Rates admin page until v0.2.0. Implementing touches the data layer (cost_rates / billable_rates tables already exist in the schema).
- Contract test: in-scope now (prevention) vs deferred. Recommend in-scope — it's the durable fix for the whole M7 class.

The debugger should recommend a direction per row; the user picks at gate (a).

## Acceptance criteria (from issue)
1. `/dashboard`, `/financial`, `/schedule`, and Admin › Rates load real data as Alice (manager/admin) without 400/404.
2. A contract test fails if any frontend endpoint path/params drift from the backend.
3. `pnpm test` stays green (current baseline 428 pass + 1 known pre-existing `RbacScopeService` failure).
4. CHANGELOG `[Unreleased] / Fixed` entry referencing #4.

## Scope guardrails
- Do NOT touch the real-Entra-in-prod OIDC path (fail-closed, v0.2.0).
- Do NOT regress the INC-003 throttle fix (`/me` off the auth bucket) or INC-001/INC-002 fixes.
- Do NOT touch `.github/` (still needs the `workflow` OAuth scope; leave untracked, as in INC-001/002/003).
- Stay scoped to #4. #5 (timer UI) is a SEPARATE issue — do not build the timer here.
- RBAC: financial/cost data must stay role-gated (Admin/FinMgr only for cost columns) — any new/aligned endpoint must preserve the existing `RbacScopeService` + cost-stripping behavior. Do NOT widen visibility.
- If new DB access is needed for rate controllers, reuse existing tables/migrations; avoid new migrations unless unavoidable (and flag if so).
- GOTCHA: `docker compose down` does NOT re-import `infra/keycloak/realm.json` (KC_DB=dev-file persists the volume) — irrelevant unless the realm changes (it should not here).

## Next step
Dispatch `debugger` to reproduce all five failures live (authenticated curl + a browser pass), confirm both-side contracts against `openapi.yaml`, and write `ROOT_CAUSE.md` + `HOTFIX_PLAN.md` + per-row fix-direction recommendation + suggested fix lanes. **Does NOT implement the fix.**

## HITL gates
- **(a)** After the debugger confirms root cause + presents fix-direction options, before dispatching the fix.
- **(b)** Before pushing the commit. Commit + push to main (closes #4) only after gate (b).
