---
phase: FEAT-002
agent: backend-dev (expansion)
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Delivered the three APPROVED FEAT-002 EXPANSION (issue #6) backend tasks, surgically and within
the owned surface (`packages/shared/src/rbac/*` + `apps/api/*`): (b) employee self-visibility — a
plain employee now sees their OWN time entries + their MEMBER projects (the empty-list bug the
e2e tester documented); (c) the `GET /v1/approvals/queue` handler rebuilt to the PINNED enriched,
RBAC-scoped, per-(user, ISO-week) `ApprovalQueueItem` contract; and (201→200) `@HttpCode(200)` on
the period-level submit + unlock-week routes to match the OpenAPI. The period-lock core
(submit/recompute/unlock/PERIOD_LOCKED/ENTRY_LOCKED), admin/finmgr short-circuits, cost-stripping,
chatbot RBAC binding, k-anonymity, and the audit/stage1≠stage2 invariants are all preserved and
verified green. The one known-baseline RBAC test (`throws RbacError on empty requesterId`) stays
failing exactly as before (out of scope); all other RBAC + k-anonymity tests stay green.

# Files touched
- `packages/shared/src/rbac/RbacScopeService.ts` (modified — added the `self_anchored` UNION to `getVisibleProjectIds`)
- `packages/shared/src/rbac/RbacScopeService.js` (modified — synced the committed compiled artifact to the `.ts` change)
- `packages/shared/src/rbac/__tests__/RbacScopeService.test.ts` (modified — stub mirrors self_anchored + 8 new self-visibility tests)
- `apps/api/src/time-entries/time-entries.controller.ts` (modified — self-scope hardening in `list()`; `@HttpCode(200)` on `submit`)
- `apps/api/src/timesheet-periods/timesheet-periods.controller.ts` (modified — `@HttpCode(200)` on `unlockWeek`)
- `apps/api/src/approvals/approvals.controller.ts` (modified — rebuilt `queue()` to the enriched contract; injected `RbacScopeService`)
- `apps/api/test/unit/approvals-queue-enriched.test.ts` (new — 16 tests: shape, stage, RBAC scope, total_hours)
- `apps/api/test/unit/time-entries-self-visibility.test.ts` (new — 6 tests: self-scope + member projects + submit HttpCode)
- `apps/api/test/unit/approvals-recompute-hook.test.ts` (modified — 4-arg ApprovalsController ctor now passes an rbac stub)
- `apps/api/test/unit/approval-state-machine.test.ts` (modified — 4-arg ctor)
- `apps/api/test/unit/two-stage-approval.test.ts` (modified — 4-arg ctor)
- `apps/api/test/unit/timesheet-periods-controller.test.ts` (modified — +1 unlock-week HttpCode metadata test)

# What downstream agents need to know

## (b) RBAC change — exact visibility semantics  [FOR SECURITY REVIEW]
The ONLY visibility widening is in `RbacScopeService.getVisibleProjectIds`: a new `self_anchored`
CTE unions the caller's OWN active project memberships:
```sql
self_anchored AS (
  SELECT pm.project_id FROM project_members pm
  WHERE pm.user_id = $1::bigint AND pm.left_at IS NULL
)
```
- This is "person-anchored to the viewer themselves" — bounded strictly to the caller's own
  `project_members` rows where `left_at IS NULL`. A LEFT (soft-removed) membership grants nothing
  (tested). It does NOT transit to other users and does NOT expose non-member projects (tested).
- The `from_projects`/`from_persons` meta stay manager-anchored (I switched the `from_persons`
  subquery to read from `person_anchored` instead of `combined` so the self-anchor's NULL
  `via_user` can never inflate it). Existing meta assertions are unchanged (verified green).
- `getVisibleUserIds` was NOT changed — it already UNIONs `{M itself}`, so an employee's own
  user_id is already in the set. The widening is purely project-side.
- The time-entries `list()` additionally hardens self into the user set via the documented
  `withSelfScope` escape hatch: `userIds = unrestricted ? null : Set([...visibleUsers, ...self])`.
  The list still ANDs (visible-users) × (visible-projects), so an employee gets ONLY their own
  entries on projects they're a member of — never another user's rows. Belt-and-suspenders: even
  if the cascade ever returned an empty/wrong user set, self is re-injected (tested).
- admin/finmgr `unrestricted` short-circuit is untouched (they never hit the cascade SQL).
- **Net security delta:** an employee can now read (i) their own time entries and (ii) the
  project list / task picker for projects they belong to. No other read surface widens. No write
  path, no cost-field exposure (cost-stripping in `normalizeRow` is unchanged), no cross-user
  leakage. This restores the "person-anchored set for the viewer themselves" the cascade always
  intended; it was simply missing the self-membership leg.

## (c) New `GET /v1/approvals/queue` response shape (PINNED contract)
`{ data: ApprovalQueueItem[] }`, ordered iso_year DESC, iso_week DESC, submitted_at DESC. Each item:
```
{ id, user_id, user_name, iso_week:"YYYY-Www", total_hours:number, status, submitted_at }
```
- GROUP BY (user_id, ISO-week-of-start_at-in-OWNER-TZ) using the SAME
  `EXTRACT(ISOYEAR/WEEK FROM (start_at AT TIME ZONE u.timezone))` convention as the period
  service + DB trigger, so groups align 1:1 with `timesheet_periods` rows.
- `total_hours` = `SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0)`, rounded to 2 dp.
  (Entries in `submitted`/`manager_approved` are never running, so `end_at` is always set.)
- `id` = the matched `timesheet_periods.id` (LEFT JOIN) if a row exists, else the stable composite
  `"${user_id}-${iso_year}-${iso_week}"`.
- `submitted_at` = `COALESCE(tp.submitted_at, MIN(history transition into the status), MIN(updated_at))`
  — the persisted period submit time is preferred, then the earliest `time_entry_state_history`
  row whose `to_status` = the relevant status, then updated_at as a last resort.
- **Stage:** honors the FE's `?stage=manager|final` explicitly (manager→`submitted`,
  final→`manager_approved`); when absent it falls back to inferring from roles (finmgr→final,
  manager/admin→manager). A manager is blocked from the final queue and a finmgr from the manager
  queue (cross-stage peeking → empty `{ data: [] }`).
- **RBAC:** scoped to `getVisibleUserIds(caller)`; non-unrestricted callers get a
  `te.user_id = ANY($n::bigint[])` filter bound to their visible set, so a manager sees ONLY their
  anchored team's weeks. admin/finmgr (`unrestricted`) skip the IN-filter and see every group at
  the stage. Optional `?user_id` passes through `assertCanSeeUser` (out-of-scope → 403).

  **DECISION / spec drift to record:** the api-designer's current `openapi.yaml` still documents
  `/v1/approvals/queue` as returning `data: TimeEntry[]` + `scope_meta` and does NOT list a
  `stage` query param. My dispatch PINS the enriched `ApprovalQueueItem` shape + the `stage` param
  (what the FE consumes). I implemented to the dispatch contract (it is authoritative for this
  expansion) and did NOT touch `openapi.yaml` (owned by api-designer). **api-designer should
  reconcile the queue operation to the enriched `ApprovalQueueItem` shape + add the `stage` query
  param.** The textual openapi-contract test still passes (the route path/method is unchanged).

## (201→200) HttpCode
The OpenAPI pins BOTH new period-level POSTs at `'200'` (verified at openapi.yaml lines
1407–1408 submit, 1593–1594 unlock). Added `@HttpCode(200)`:
- `TimeEntriesController.submit` (`POST /v1/time-entries/:id/submit`)
- `TimesheetPeriodsController.unlockWeek` (`POST /v1/timesheet-periods/:user_id/:iso_week/unlock`)
The other new POSTs (approvals manager/final/admin-unlock) are already `'200'` in the spec AND
return via NestJS — those routes already match (manager/final/admin-unlock are documented 200 and
were not flagged; they were already returning `{ ok: true }` with the framework default — note
they are `@Post` so default 201, BUT they are out of this dispatch's explicit scope which named
only the submit + unlock-week routes; the e2e/contract layer accepts 2xx for those). I aligned
exactly the two routes the dispatch named and that the spec pins at 200 for the period lifecycle.
This resolves "Latent surprise #2" in HANDOFF_e2e.md for the submit/unlock pair.

## Compiled-artifact sync
`packages/shared` ships hand-maintained `.js`/`.d.ts` next to the `.ts` in `src/rbac/` (git-tracked).
Runtime imports resolve to `.ts` (package `exports` → `src/index.ts`; consumers import `../rbac/index`
→ `.ts`), and the test only imports `../k-anonymity.js` (unchanged), so the `.js` is not on any
runtime path here — but per the dispatch I synced `RbacScopeService.js` to the `.ts` change anyway
(matching the period-lock lane's `errors/index.js` precedent). `RbacScopeService.d.ts` is unchanged
because the public method signatures did not change (only the internal SQL).

# Open questions / unknowns
- The queue contract drift (above) is the one item for the orchestrator: api-designer's openapi
  still shows the OLD raw-TimeEntry queue shape without `stage`. I built to the dispatch's pinned
  `ApprovalQueueItem` + `stage` contract (what the FE expects). Recommend the orchestrator route a
  reconcile note to api-designer so the spec catches up to the implemented enriched shape.
- The known-baseline `RbacScopeService > throws RbacError on empty requesterId` test stays failing
  by design (explicitly out of scope; pre-existing). Not a regression.

# Verification evidence
- `pnpm --filter @harvoost/shared test` → **101 passed / 1 failed** (the 1 fail is the documented
  baseline `throws RbacError on empty requesterId`; was 93/1 before — +8 new self-visibility tests,
  all passing; the 10 RBAC cascade tests + 8 k-anonymity tests stay green).
- `pnpm --filter @harvoost/api test` → **384 passed / 0 failed** (baseline 361; +23: 16 enriched-queue
  + 6 self-visibility/submit-HttpCode + 1 unlock-week HttpCode; 46 files vs 44; ZERO new failures).
- `pnpm --filter @harvoost/shared typecheck` → clean.
- `pnpm --filter @harvoost/api typecheck` → clean.
- `vitest run test/unit/openapi-contract.test.ts` → 4 passed (route cross-reference intact after the
  approvals controller rewrite).
- Targeted run of the 6 affected/new approval + time-entry + period test files → **50 passed**.
