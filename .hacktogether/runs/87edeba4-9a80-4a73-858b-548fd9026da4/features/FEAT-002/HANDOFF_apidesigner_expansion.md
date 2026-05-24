---
phase: features/FEAT-002 (EXPANSION, GitHub #6)
agent: api-designer
started: 2026-05-24
finished: 2026-05-24
status: blocked-on-apply
---

# Summary
Re-specified the ENRICHED `GET /v1/approvals/queue` contract and made the `@harvoost/contract`
suite enforce it. The endpoint changes from raw per-entry `TimeEntry` rows to ENRICHED
per-(user, ISO-week) `ApprovalQueueItem` rows: `200 → { data: ApprovalQueueItem[] }`, query params
`stage` (enum `manager|final`, optional) + `limit` (the shared 1..200/default-50 `Limit` param).
The period-level **submit** (`POST /v1/time-entries/{entry_id}/submit`) and **unlock-week**
(`POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock`) responses were verified to ALREADY be
documented as `200` (matching the backend lane's `@HttpCode(200)` work) — left unchanged.

# Files touched
- `tests/contract/src/contract-spec.ts` (modified) — DONE. Added a `GET /v1/approvals/queue`
  `LOAD_BEARING` entry: `shape: 'paginated-data'`, `envelopeKey: 'data'`,
  `reads: [id, user_id, user_name, iso_week, total_hours, status, submitted_at]`. Removed the now
  STALE `'GET /v1/approvals/queue': ['stage']` entry from `KNOWN_PARAM_DRIFT` (the `stage` query key
  is a DECLARED param in the new spec, so it no longer needs a drift allowance).
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml.feat002-queue.patch`
  (new) — the TWO byte-exact YAML fragments to apply to `openapi.yaml`. NOT loaded by anything;
  it is a carrier for the spec edit (see blocking note below).
- `.hacktogether/runs/.../03-api-design/openapi.yaml` (modified — REQUIRED, NOT YET APPLIED).

# What downstream agents need to know
- **BLOCKING — apply the spec patch before running `@harvoost/contract`.** The api-designer
  sandbox had only Read/Write/Grep/Glob (no Edit, no Bash). `openapi.yaml` is 4922 lines, which
  exceeds a single Write's output budget, so an in-place surgical edit was impossible from this
  lane. The exact change is staged in `openapi.yaml.feat002-queue.patch` as two fragments to be
  applied verbatim (an Edit-capable lane or the orchestrator does this; ~10 min, mechanical):
    - FRAGMENT 1 — REPLACE the whole `/v1/approvals/queue:` GET operation block (the old raw
      `allOf CursorPaginationMeta + { data: TimeEntry[], scope_meta }` version, Cursor/Limit/
      user_id/iso_week params) with the new enriched op: `stage` + `Limit` params,
      `200 → { data: ApprovalQueueItem[] }`.
    - FRAGMENT 2 — INSERT the new `ApprovalQueueItem` component schema into `components.schemas`
      in the `# ---------- Approvals ----------` block, immediately AFTER `ApprovalBatchResponse`
      and BEFORE `# ---------- Exceptions ----------`.
  After applying, delete the `.patch` carrier file. The YAML stays valid (`yaml.parse`-clean): the
  op block and the schema are self-contained, correctly-indented blocks; no unrelated section is
  reflowed.
- **`contract-spec.ts` and the spec are now MUTUALLY DEPENDENT.** The suite will FAIL if you run it
  against the OLD (un-patched) spec — by design: (a) the new `LOAD_BEARING` read-fields assertion
  fails because raw `TimeEntry` rows lack `user_name`/`iso_week`/`total_hours`; and (b) the
  FE-query-keys assertion for `GET /v1/approvals/queue` fails because `stage` is now unwhitelisted
  AND undeclared on the old spec. Both go green once FRAGMENT 1+2 are applied. This is exactly the
  intended behaviour ("would have FAILED on the old raw-row spec").
- `ApprovalQueueItem` fields (all string-encoded ids per the period contract): `id` (period id, or
  composite `${user_id}-${iso_year}-${iso_week}`), `user_id`, `user_name`, `iso_week` (`YYYY-Www`),
  `total_hours` (number), `status` (`submitted | manager_approved`), `submitted_at` (date-time).
  Verified against the FE reads in `apps/web/app/approvals/page.tsx` (maps `user_name`, `iso_week`,
  `total_hours`, `status`, `submitted_at`; keys on `id`; admin unlock button reads `user_id` +
  `iso_week`) and `.../approvals/final/page.tsx` (sends `stage: 'final', limit: 200`).
- The `data`-only envelope (no `scope_meta`, no cursor meta) matches the FE, which reads
  `queue.data?.data ?? []`. The `paginated-data` resolver only needs the `data` array key, which is
  present.

# Open questions / unknowns
- None on the contract itself. The only open item is the mechanical apply of the staged spec patch
  (above) — required before verify.

# Verification evidence
- Could not run tests (no Bash in this lane). Correct-by-construction analysis instead:
  - `tests/contract/src/contract.test.ts` generates exactly 2 `it()` per `LOAD_BEARING` entry
    (`…is declared + routed` + `…success schema declares the FE-read fields…`). Adding one entry
    ⇒ **+2 checks. Expected count 149 → 151**, all green AFTER the spec patch is applied.
  - Removing the `KNOWN_PARAM_DRIFT['GET /v1/approvals/queue']` entry adds/removes NO `it()` cases
    (the FE-query-keys `it()` for that op already exists because the FE sends `stage`+`limit`); it
    only flips that case from "passes via whitelist on old spec" to "passes via declared param on
    new spec". So it does not change the count, only the pass/fail dependency on the spec apply.
  - `submit` 200: openapi.yaml line 1408 (`'200':` under `/v1/time-entries/{entry_id}/submit`) —
    confirmed 200, unchanged.
  - `unlock` 200: openapi.yaml line 1594 (`'200':` under
    `/v1/timesheet-periods/{user_id}/{iso_week}/unlock`) — confirmed 200, unchanged.
  - The reused `#/components/parameters/Limit` (line 3220) is already `int 1..200, default 50`,
    matching the pinned contract exactly.
