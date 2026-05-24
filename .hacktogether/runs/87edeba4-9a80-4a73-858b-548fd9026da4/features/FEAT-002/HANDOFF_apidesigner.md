---
phase: FEAT-002
agent: api-designer (LANE 4 — openapi + contract)
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Specced the FEAT-002 (issue #6, Option F) period/timesheet locking surface in `openapi.yaml`
EXACTLY to the `>>> PINNED API SHAPES <<<` in HANDOFF_backend.md, and reconciled the contract test
(`tests/contract/src/contract-spec.ts`) so `@harvoost/contract` stays green against the updated spec:
added `PERIOD_LOCKED` to the `ErrorCode` enum; fixed the `POST /v1/time-entries/{entry_id}/submit`
200 body (string-encoded bigint ids + the `reason` enum) and added its 400; declared the three new
`/v1/timesheet-periods` operations + a `TimesheetPeriod` (+ unlock req/resp) component schema; added
`409 PERIOD_LOCKED` to all five time-entry write paths; removed the now-closed submit route from
`KNOWN_ROUTE_GAP` and promoted the three FE-read endpoints into `LOAD_BEARING`.

NOTE ON METHOD: the `Edit` tool was disabled in this context, so `openapi.yaml` was reproduced in
full via a single `Write` with the edits inlined. The whole 4510-line file was read first and
reproduced verbatim except for the intended changes; unrelated sections were not reflowed.

# Files touched
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml` (modified)
- `tests/contract/src/contract-spec.ts` (modified)

# What downstream agents need to know

## openapi.yaml — ops & schemas added/changed (all to the pinned shapes)
- **`ErrorCode` enum**: added `PERIOD_LOCKED` (between `ENTRY_LOCKED` and `CHATBOT_DISABLED`). Also
  added a `PERIOD_LOCKED` example to the `ErrorResponse.examples` list.
- **`POST /v1/time-entries/{entry_id}/submit`** (existing op, corrected): request unchanged
  (`SubmitTimeEntryRequest` = `{ scope: entry|week (default entry), iso_week?: ^\d{4}-W\d{2}$ }`);
  200 body now `{ submitted_ids: string[], skipped: [{ entry_id: string, reason: enum[running,
  already_submitted] }] }` (ids were `integer` → now `string`-encoded bigints, reason now an enum);
  added `400 VALIDATION_FAILED`; kept `401/403/404`. Examples use string ids + both skip reasons.
- **`GET /v1/timesheet-periods`** (new): query `user_id? (int64)`, `status?
  (TimesheetPeriodStatus)`, `limit? (1..200 default 50)`; 200 = `{ data: TimesheetPeriod[] }`.
- **`GET /v1/timesheet-periods/{iso_week}`** (new): path `iso_week` via new `IsoWeekPath`
  parameter (`^\d{4}-W\d{2}$`); 200 = a single `TimesheetPeriod`; `400 VALIDATION_FAILED`. Two
  examples: a persisted row and the OPEN SHELL (`id` omitted, `week_start_date: null`).
- **`POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock`** (new, admin): body
  `UnlockTimesheetWeekRequest = { reason: string(minLength 20) }`; 200 =
  `UnlockTimesheetWeekResponse = { unlocked_ids: string[], user_id, iso_year, iso_week }`;
  `400 VALIDATION_FAILED`, `403 RBAC_FORBIDDEN` (via the shared `Forbidden` response).
- **`409 PERIOD_LOCKED`** added to: `POST /v1/time-entries` (createManual), `POST /v1/time-entries/start`,
  `POST /v1/time-entries/switch`, `PATCH /v1/time-entries/{entry_id}`, `DELETE /v1/time-entries/{entry_id}`.
  Implementation detail: create/PATCH/DELETE already had a single `409` key (and YAML forbids a
  duplicate key), so PERIOD_LOCKED was folded into each op's EXISTING `409` via `examples`
  (`overlap`/`entry_locked`/… + a `period_locked` example) rather than a second `409` block. A
  reusable `PeriodLocked` response component was added under `components.responses` for documentation
  /future reuse, but the in-op 409s use inline `examples` to coexist with the pre-existing causes.
- **New component schemas**: `TimesheetPeriodStatus` (enum), `TimesheetPeriod` (modelled as ONE object
  schema — `id` optional/omitted in the open shell, `week_start_date` nullable — NOT a oneOf, so the
  contract row-prop resolver sees the full field set), `UnlockTimesheetWeekRequest`,
  `UnlockTimesheetWeekResponse`. New parameter `IsoWeekPath`. New tag `TimesheetPeriods`.
- Reused existing shared pieces where they fit: `ErrorResponse`, the `Forbidden`/`ValidationFailed`/
  `Unauthorized`/`NotFound` responses, `UserIdPath`, `EntryIdPath`.

## tests/contract/src/contract-spec.ts — what changed
- **Removed from `KNOWN_ROUTE_GAP`**: `'POST /v1/time-entries/{param}/submit'`. The route is now
  REGISTERED (`@Post(':id/submit')` on the time-entries controller). `KNOWN_ROUTE_GAP` is now `[]`
  (empty — fine, as the dispatch anticipated). `KNOWN_SPEC_GAP` remains `[]`.
- **Added three `LOAD_BEARING` entries** (declared + routed + read-field asserted), keys
  `{param}`-normalized exactly like the INC-006/INC-007 entries:
  - `POST /v1/time-entries/{param}/submit` — `shape:'object'`, reads `[submitted_ids, skipped]`.
  - `GET /v1/timesheet-periods/{param}` — `shape:'object'`, reads `[user_id, iso_year, iso_week,
    status, entry_counts]`.
  - `GET /v1/timesheet-periods` — `shape:'paginated-data'`, envelopeKey `data`, reads `[id, user_id,
    iso_year, iso_week, status, entry_counts]`.

## Spec ↔ contract ↔ backend ↔ frontend consistency (verified by construction)
- L5 (frontend) HAS ALREADY LANDED period code in `apps/web/src/lib/timesheet-periods.ts` +
  `apps/web/src/components/UnlockWeekButton.tsx`. The contract scanner (which reads `apps/web/{app,src}`)
  therefore picks up THREE period/submit `apiFetch` calls, all of which my spec now declares AND the
  backend routes:
  - `GET /v1/timesheet-periods/{param}` (fetchPeriod) — declared ✓ routed ✓ (no query keys).
  - `POST /v1/time-entries/{param}/submit` (submitWeek) — declared ✓ routed ✓.
  - `POST /v1/timesheet-periods/{param}/{param}/unlock` (unlockWeek) — declared as
    `/v1/timesheet-periods/{user_id}/{iso_week}/unlock` (→ `{param}/{param}/unlock`), backend
    `@Post(':user_id/:iso_week/unlock')` ✓. Not in LOAD_BEARING (the generic FE-call existence +
    404-guard cover it), no query keys so no param-drift assertion.
- The FE `__tests__/feat002-period-lock.test.ts` is under `apps/web/__tests__/` — OUTSIDE the
  scanner's `WEB_SRC_DIRS` (`apps/web/app`, `apps/web/src`) — so it is not scanned.

## Expected `@harvoost/contract` count delta (cannot run — no Bash)
Baseline 139. The test generates cases dynamically: 2 per unique FE call (declared-op + route-guard),
+1 more for calls with query keys, +2 per LOAD_BEARING entry, plus 5 fixed (4 sanity + 1 enumeration).
- L5 introduced 2 NEW unique FE calls (`GET /v1/timesheet-periods/{param}`, the unlock POST); the
  submit call already existed in the 139 baseline (it was the KNOWN_ROUTE_GAP). Neither new call has
  query keys → **+4** (2 calls × {existence, route-guard}).
- LOAD_BEARING grew by 3 entries → **+6** (3 × {declared+routed, read-fields}).
- **Expected total ≈ 149 (delta ≈ +10), all passing.** If L5's call inventory differs slightly from
  what I scanned, the FE-call portion of the delta moves with it; the LOAD_BEARING +6 is fixed.
  No existing check should flip: the submit route-guard flips from "relaxed (gap)" to a real pass
  (route is registered); `start_at_from`/`start_at_to`/`stage`/`mine` param drift entries are
  untouched.

## For the orchestrator's Decision log
- **Decision (409 modelling):** PERIOD_LOCKED on create/start/switch/PATCH/DELETE is documented inside
  each op's pre-existing single `409` response via `examples` (a `period_locked` example alongside the
  existing `VALIDATION_FAILED`/`ENTRY_LOCKED`/`IDEMPOTENCY_CONFLICT` causes), because OpenAPI/YAML
  cannot carry two `409` keys on one operation. A reusable `components.responses.PeriodLocked` was
  also added for clarity/future single-cause ops.
- **Decision (TimesheetPeriod open-shell modelling):** the GET-single 200 is ONE object schema with
  `id` optional + `week_start_date` nullable (not a `oneOf` of persisted|shell). Rationale: the
  contract test's `objectProps`/`resolveRowProps` only descends the first object branch of a oneOf,
  so a oneOf would hide half the fields from the read-field assertion; a single permissive object
  schema both matches the pinned shape and resolves cleanly. The `required` list is the open-shell's
  minimum (`user_id, iso_year, iso_week, status, entry_counts`); `id`/`week_start_date` are optional.

# Open questions / unknowns
- None blocking. One caveat the orchestrator should note: `openapi.yaml` was rewritten via full-file
  `Write` (Edit was unavailable). I reproduced the 4510-line source verbatim outside the intended
  edits; a YAML lint / `@harvoost/contract` run at verify is the backstop. If the verify run surfaces
  any accidental drift in an UNRELATED section, it would be from this round-trip — but the contract
  suite parses the whole spec (`yaml.parse`) on load, so a structural break would fail `scan sanity`
  loudly rather than silently.

# Verification evidence
- Cannot run tests (no Bash). Correct-by-construction checks performed:
  - Traced all three FE period/submit `apiFetch` calls (`apps/web/src/lib/timesheet-periods.ts`,
    `UnlockWeekButton.tsx`) → every one resolves to a declared op whose route is registered in
    `apps/api/src` (verified the controllers: `time-entries.controller.ts` `@Post(':id/submit')`,
    `timesheet-periods.controller.ts` `@Get()`, `@Get(':iso_week')`, `@Post(':user_id/:iso_week/unlock')`).
  - Verified each LOAD_BEARING entry's `reads` against the spec's resolved 200 schema using the same
    `resolveRowProps`/`objectProps` logic the test uses (object → own props; paginated-data → `data`
    array items props).
  - Confirmed `KNOWN_ROUTE_GAP`/`KNOWN_SPEC_GAP` are both `[]` and the suite no longer relaxes any
    FE-consumed endpoint.

# Pinned summary (tight)
openapi: +`PERIOD_LOCKED` enum; submit-200 → string ids + reason enum + 400; +3 `/v1/timesheet-periods`
ops (`GET list`, `GET {iso_week}` self open-shell, `POST {user_id}/{iso_week}/unlock` admin) + a
`TimesheetPeriod` (+unlock req/resp) schema + `IsoWeekPath` param + `PeriodLocked` response; +409
PERIOD_LOCKED (as a `period_locked` example folded into the existing 409) on create/start/switch/
PATCH/DELETE. contract: removed the submit entry from `KNOWN_ROUTE_GAP` (now empty); +3 LOAD_BEARING
(submit, period-GET, period-list). Spec+contract mutually consistent; expected `@harvoost/contract`
≈ 149 (delta ≈ +10), all green.
