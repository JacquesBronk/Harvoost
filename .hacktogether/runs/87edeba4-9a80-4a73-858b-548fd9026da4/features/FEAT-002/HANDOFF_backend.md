---
phase: FEAT-002
agent: backend-dev (LANES 2+3 — shared error + backend)
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Implemented L2 (shared `PERIOD_LOCKED` / `PeriodLockedError`) and L3 (the full backend) for FEAT-002
Option F per DESIGN. Added a `PeriodService` (resolveWeek / assertPeriodWritable / recomputePeriod +
the `HV001`→`PeriodLockedError` mapper), wired the `POST /v1/time-entries/{id}/submit` route (fills
the INC-004 KNOWN_ROUTE_GAP) with `scope=entry|week`, added `assertPeriodWritable` prechecks at
createManual / PATCH-move / start / switch / DELETE (DELETE-into-locked-week is the APPROVED
hardening), added `recomputePeriod` hooks inside the existing `managerAction` / `finalAction` /
`adminUnlock` transactions (no contract change, stage1≠stage2 preserved), and a new
`timesheet-periods` module with a self GET, a list GET, and an admin **unlock-week** endpoint that
loops the existing per-entry admin-unlock (same audit/history, no new authority). Period status is a
derived rollup of the user's non-`running` entries in the ISO-week (owner TZ), computed with the SAME
`EXTRACT(ISOYEAR/WEEK FROM (ts AT TIME ZONE tz))` SQL the DB trigger uses, so app and DB agree.

# Files touched
- `packages/shared/src/errors/index.ts` (modified — `PERIOD_LOCKED` enum + `PeriodLockedError`)
- `packages/shared/src/errors/index.js` (modified — regenerated committed artifact: the in-package
  errors test imports `../index` which resolves to this `.js`; kept in sync with the `.ts`)
- `packages/shared/src/errors/index.d.ts` (modified — same reason, type surface)
- `packages/shared/src/errors/__tests__/errors.test.ts` (modified — assert PERIOD_LOCKED + 11 codes)
- `apps/api/src/timesheet-periods/period.service.ts` (new — PeriodService + `mapPeriodLockDbError` + `LOCKED_PERIOD_STATUSES`)
- `apps/api/src/timesheet-periods/timesheet-periods.controller.ts` (new — GET single, GET list, POST unlock-week)
- `apps/api/src/timesheet-periods/timesheet-periods.module.ts` (new — provides+exports PeriodService)
- `apps/api/src/time-entries/time-entries.controller.ts` (modified — submit route, lock prechecks, HV001 maps)
- `apps/api/src/time-entries/time-entries.module.ts` (modified — imports TimesheetPeriodsModule)
- `apps/api/src/approvals/approvals.controller.ts` (modified — recompute hooks in mgr/final/admin-unlock)
- `apps/api/src/approvals/approvals.module.ts` (modified — imports TimesheetPeriodsModule)
- `apps/api/src/app.module.ts` (modified — registers TimesheetPeriodsModule)
- `apps/api/test/unit/period-service.test.ts` (new — rollup, lock-oracle, HV001 mapping)
- `apps/api/test/unit/time-entries-period-lock.test.ts` (new — PERIOD_LOCKED at every enforcement point + submit-week)
- `apps/api/test/unit/timesheet-periods-controller.test.ts` (new — GET + unlock-week)
- `apps/api/test/unit/approvals-recompute-hook.test.ts` (new — recompute hooks + stage1≠stage2 preserved)
- `apps/api/test/unit/{time-entries-controller,time-entries-txn,time-entry-patch-validation,approval-state-machine,two-stage-approval}.test.ts` (modified — pass the new PeriodService ctor arg / stub)
- `apps/api/test/e2e/time-entries-task-id.e2e.test.ts` (modified — construct controller with a real PeriodService)

# What downstream agents need to know

## >>> PINNED API SHAPES (api-designer specs these EXACTLY; frontend consumes) <<<

### POST /v1/time-entries/{entry_id}/submit  (KNOWN_ROUTE_GAP now CLOSED — move out of the gap list)
- Auth: any authenticated user, **self-only** (the entry must belong to the caller, else `404 NOT_FOUND`).
- Request body `SubmitTimeEntryRequest`:
  ```json
  { "scope": "entry" | "week", "iso_week": "YYYY-Www" }
  ```
  `scope` defaults to `"entry"`. `iso_week` (regex `^\d{4}-W\d{2}$`) is OPTIONAL and only honored for
  `scope="week"` (overrides the anchor entry's week). The FE sends `{ "scope": "week" }`.
- Response `200`:
  ```json
  { "submitted_ids": ["10","11"], "skipped": [ { "entry_id": "12", "reason": "running" },
                                               { "entry_id": "13", "reason": "already_submitted" } ] }
  ```
  `submitted_ids` are string-encoded bigints. `reason` ∈ { `"running"`, `"already_submitted"` }.
- Errors: `404 NOT_FOUND` (not yours / missing), `400 VALIDATION_FAILED` (bad iso_week).
  Submit itself is NEVER `PERIOD_LOCKED` (it CREATES the locked state; the draft→submitted UPDATEs are
  status-only so the DB trigger does not fire).

### GET /v1/timesheet-periods/{iso_week}  (self)
- `{iso_week}` path param is `YYYY-Www` (e.g. `2026-W21`); malformed → `400 VALIDATION_FAILED`.
- Response `200` (a persisted row OR, when no row exists, a synthesized **open** shell):
  ```json
  { "id": "7", "user_id": "3", "iso_year": 2026, "iso_week": 21, "week_start_date": "2026-05-18",
    "status": "open"|"submitted"|"manager_approved"|"final_approved"|"rejected",
    "submitted_at": "...|null", "submitted_by": "3|null",
    "manager_approved_at": "...|null", "final_approved_at": "...|null", "reopened_at": "...|null",
    "entry_counts": { "draft":0,"submitted":5,"manager_approved":0,"final_approved":0,"rejected":0 } }
  ```
  The open shell omits `id` and returns `week_start_date: null` (no row yet) — same field set otherwise.

### GET /v1/timesheet-periods  (list; self + RBAC-visible)
- Query: `?user_id` (numeric, must be RBAC-visible — self always passes), `?status`, `?limit` (1..200, default 50).
- Response `200`: `{ "data": [ <same period shape as the single GET, always with id + entry_counts> ] }`,
  ordered `iso_year DESC, iso_week DESC`.

### POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock  (admin unlock-week — CHOSEN URL SHAPE)
- **This is the unlock-week URL shape I chose:** path = `(user_id, iso_week)` because a period is keyed
  by (user, ISO-week) and there is no period-id in the contract. `@Roles('admin')`.
- `{user_id}` numeric, `{iso_week}` = `YYYY-Www`. Request body: `{ "reason": "<min 20 chars>" }`
  (same threshold as per-entry admin-unlock).
- Behavior: loops the EXISTING per-entry admin-unlock over every LOCKED entry in the week (drop to
  draft + `time_entry_state_history` row preserving `from_status` + an `approval.admin_unlock` audit
  row, identical to N manual unlocks), then `recomputePeriod` → the week reopens to `open`,
  `reopened_at` set.
- Response `200`:
  ```json
  { "unlocked_ids": ["20","21"], "user_id": "3", "iso_year": 2026, "iso_week": 21 }
  ```
- Errors: `400 VALIDATION_FAILED` (bad user_id / iso_week / reason < 20), `403 RBAC_FORBIDDEN` (non-admin).

### PERIOD_LOCKED error envelope (added to ErrorCode)
- `409` with `{ "code":"PERIOD_LOCKED", "message":"Cannot write into week 2026-W21 — it is submitted and locked.", "details": { "iso_year":2026, "iso_week":21, "status":"submitted" } }`.
- Now returned by: `POST /v1/time-entries` (createManual), `PATCH /v1/time-entries/{id}` (when start_at/end_at
  moves into a locked week), `POST /v1/time-entries/start`, `.../switch`, and `DELETE /v1/time-entries/{id}`
  (the APPROVED hardening). api-designer: add `409 PERIOD_LOCKED` responses to those ops + the
  `PERIOD_LOCKED` enum member to the openapi `ErrorCode`.

## HV001 mapping
- The DB lock trigger raises SQLSTATE **`HV001`** (per HANDOFF_db). `mapPeriodLockDbError()` in
  `period.service.ts` translates any caught error carrying `code==='HV001'` (or `meta.code`, or the
  `PERIOD_LOCKED`/`HV001` substring in the message) into a clean `PeriodLockedError`, parsing
  `iso_year`/`iso_week`/`status` from the trigger's DETAIL line or message. It is invoked in the catch
  blocks of createManual, PATCH, start and switch as the TOCTOU backstop (mirrors the GiST `23P01`
  mapping pattern). Non-HV001 errors pass through untouched.

## Behavioral / consistency notes
- **Lock enforcement ordering on PATCH/DELETE:** the entry's own-status `ENTRY_LOCKED` check fires
  FIRST (preserved), THEN the destination-period `PERIOD_LOCKED` check. A submitted entry → ENTRY_LOCKED;
  a draft entry moved into a locked week → PERIOD_LOCKED.
- **Submit upsert sets a NEUTRAL `'open'` placeholder status** then stamps submitted_at/submitted_by and
  calls `recomputePeriod`, which writes the authoritative derived status. This avoids `recomputePeriod`
  falsely setting `reopened_at` on a fresh/partial submit (reopened only fires on a locked→open drop).
- **recompute never hard-deletes** a period row (DESIGN §7.6) and never CREATES a row for an empty/open
  week — open weeks have no row. A row only first appears on submit (or admin-unlock recompute keeps it).
- **D4 reopen** falls out of recompute: admin-unlock drops an entry to draft → period recomputes to
  `open` + `reopened_at`. The unlock-week endpoint is the convenience loop over that.
- **DI wiring:** `PeriodService` is provided+exported by `TimesheetPeriodsModule`; `TimeEntriesModule`
  and `ApprovalsModule` import it. `PrismaService`/`AuditService`/`RBAC_SCOPE_SERVICE` are global.

## For the orchestrator's Decision log
- **Decision (unlock-week URL):** `POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock` with
  `{ reason }` — keyed by (user_id, iso_week) since the contract has no period id. Reuses per-entry
  admin-unlock audit/history; no new authority. (DESIGN §5 / §7.4 "unlock week" convenience, APPROVED.)
- **Decision (DELETE hardening):** DELETE into a locked week is now BLOCKED with PERIOD_LOCKED (changes
  DESIGN §5's "DELETE unchanged" per the APPROVED hardening in the dispatch).
- **Note (build):** `apps/api`'s `nest build` fails project-wide with pre-existing `TS6059 rootDir`
  errors (shared resolves to `src/*.ts` via tsconfig paths, outside apps/api rootDir) — NOT introduced
  here; required verifications are `test` + `typecheck`, both clean.

# Open questions / unknowns
- None blocking. api-designer (L4) must: add `PERIOD_LOCKED` to openapi `ErrorCode`; move
  `POST /v1/time-entries/{entry_id}/submit` out of `KNOWN_ROUTE_GAP` into the registered set; add the
  three `/v1/timesheet-periods` ops + a `TimesheetPeriod` schema; add `409 PERIOD_LOCKED` to
  createManual/PATCH/start/switch/DELETE. The `openapi-contract.test.ts` unit test already allowlists
  the submit op, so it stays green regardless; the route IS now registered.

# Verification evidence
- `pnpm --filter @harvoost/shared typecheck` → clean (exit 0)
- `pnpm --filter @harvoost/api typecheck` → clean (exit 0)
- `pnpm --filter @harvoost/shared test` → 93 passed + 1 KNOWN pre-existing fail
  (`RbacScopeService empty-requesterId`); baseline was 91 pass + the same 1 fail (added 2 PERIOD_LOCKED
  error tests, introduced 0 new failures).
- `pnpm --filter @harvoost/api test` → **361 passed (44 files), 0 failures** (baseline 313; +48 new:
  19 period-service + 16 time-entries-period-lock + 8 timesheet-periods-controller + 5 approvals-recompute-hook,
  plus 2 assertion adjustments folded into existing files).
- Lock proven with a non-trivial case: `submit scope=week` flips drafts→submitted, skips running +
  already-submitted, stamps the period, and recompute sets `submitted`; subsequent createManual /
  PATCH-move / start / switch / DELETE into that submitted week all reject with `PeriodLockedError`;
  empty/future + `rejected` weeks stay writable; admin-unlock + unlock-week reopen the period to `open`.

# Pinned summary (tight)
L2: `PERIOD_LOCKED` + `PeriodLockedError(isoYear,isoWeek,status)` (409, details {iso_year,iso_week,status}).
L3: `PeriodService` (resolveWeek/assertPeriodWritable/recomputePeriod + HV001→PeriodLockedError);
`POST /v1/time-entries/{id}/submit` (scope entry|week → {submitted_ids,skipped}); PERIOD_LOCKED prechecks
at create/PATCH-move/start/switch/DELETE; recompute hooks in mgr/final/admin-unlock (no contract change,
stage1≠stage2 kept); `GET /v1/timesheet-periods[/{iso_week}]` + `POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock`.
HV001 is the TOCTOU backstop. All modules registered in app.module.ts. 361 api tests pass, typechecks clean.
