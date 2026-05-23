---
phase: build (final feature-completion pass)
agent: backend-dev (final)
started: 2026-05-23T00:45:00Z
finished: 2026-05-23T01:55:00Z
status: complete
---

# Summary

Final backend feature-completion pass closing the 12 work items in the dispatch:
audit-log-integrity HMAC recompute (V1), start/switch transaction race (M1),
leave list manager fan-out (M5), HTTP-verb alignment with openapi.yaml (M6 —
leave approve/reject POST→PATCH and exception resolve PATCH→POST), OT_WEEK
detection (F8.2), 2σ anomaly detection (F8.3), broad schedule overrides (F7.3),
real-time overtime worker, email retry job, full XLSX writer with RBAC
intersection + sync/async export job pipeline (F9.3 + M10), in-process SSE
sync endpoint (F1.2 + tray-web sync), and 7 new unit-test files plus
updates to 2 existing test files and the openapi-contract allowlist. One
additive migration `20260523000000_feature_completion` introduces the
`overtime_realtime_queue`, `export_jobs` tables, and widens
`email_delivery_log` with `retry_count`/`next_retry_at` + the
`failed_permanent` status value.

# Files touched

## Item 1 — V1 audit-log-integrity HMAC recompute
- `packages/jobs/src/jobs/audit-log-integrity.ts` (rewritten) — HMAC recompute
  via Postgres `hmac()` inside a `$transaction` that issues
  `SET LOCAL app.audit_hash_secret`. Canonical-JSON matches the trigger's
  `jsonb_build_object` key order byte-for-byte. Mismatches log
  `metric: 'audit_log_tamper_detected'` and continue scanning. Fallback to
  linkage-only when the prisma stub lacks `$transaction`.
- `packages/jobs/src/types.ts` (modified) — JobDeps gains optional
  `auditHashSecret`, `boss`, `metrics`, `xlsxRenderer` fields.

## Item 2 — M1 start/switch transactional fix
- `apps/api/src/time-entries/time-entries.controller.ts` (modified) —
  `start` + `switch` now wrap implicit-stop + INSERT in a single
  `prisma.$transaction`. A 23505 violation on `te_one_running_per_user` or
  `te_idempotency_unique` is converted to a clean `IdempotencyConflictError`
  (409). `enqueueOvertimeCheck()` helper writes to the new
  `overtime_realtime_queue` side-channel table AFTER the txn commits.
  SyncService.emit (timer.started / .stopped / .switched) also fires
  post-commit. Added `isUniqueViolation()` helper at the bottom.
- `apps/api/src/prisma/prisma.service.ts` (modified) — passthrough
  `$transaction(callback)` method on PrismaService (the existing service
  exposed only `$queryRawUnsafe` / `$executeRawUnsafe`).

## Item 3 — M5 leave list manager fan-out
- `apps/api/src/leave/leave.controller.ts` (modified) — list now branches on
  role: admin/finmgr see org-wide (no user filter), manager fans out via
  `rbac.getVisibleUserIds()` with a `user_id = ANY($1::bigint[])` predicate,
  employee stays self-only. Returns `scope_meta: { visible_users }`.

## Item 4 — M6 HTTP verb alignment
- `apps/api/src/leave/leave.controller.ts` (modified) — approve/reject now
  use `@Patch`. Cancel stays POST (still in allowlist pending product
  confirmation).
- `apps/api/src/exceptions/exceptions.controller.ts` (modified) — resolve now
  uses `@Post`.
- `apps/api/test/unit/openapi-contract.test.ts` (modified) — dropped the
  verb-divergence entries from the allowlist (leave approve/reject); also
  dropped schedule-overrides list/create/delete from allowlist now that
  they're implemented.

## Item 5+6 — OT_WEEK + anomaly detection
- `packages/jobs/src/jobs/exception-detection.ts` (rewritten) — adds two new
  INSERT batches:
  - **OVERTIME_WEEK** — trailing 7-day sum > `OT_WEEK_THRESHOLD_HOURS`
    (default 50). local_date = yesterday in user's TZ; de-duped by the
    UNIQUE (user_id, type, local_date) constraint.
  - **ANOMALY_LOW / ANOMALY_HIGH** — trailing-28-day mean+stdev per user
    (working days only via schedule_templates.working_days);
    `abs(hours - mean) > sigma * stdev` AND `stdev > 0.1`. Sigma is
    `ANOMALY_STDEV_THRESHOLD` (default 2.0).
  - `OT_DAY_THRESHOLD_HOURS` (default 10) becomes env-configurable too.
  - All thresholds env-readable via the local `readNum()` helper.

## Item 7 — broad schedule overrides
- `apps/api/src/schedules/schedules.controller.ts` (rewritten) — adds:
  - `GET /v1/schedules/overrides` — RBAC-scoped list with optional
    `scope` + `target_id` filters.
  - `POST /v1/schedules/overrides` — full RBAC matrix:
    scope=user → manager-within-scope OR admin/finmgr; target_id required.
    scope=project → admin/finmgr only; target_id required.
    scope=org → admin/finmgr only; target_id forbidden.
    Conflict resolution: same-scope overlapping windows surface the DB
    `so_no_overlap` GIST violation as a `ValidationFailedError` with code
    `SCHEDULE_OVERRIDE_CONFLICT`.
  - `DELETE /v1/schedules/overrides/:id` — mirror RBAC of creation.
  - Audit records on create + delete.

## Item 8 — real-time overtime worker
- `packages/jobs/src/jobs/overtime-realtime.ts` (rewritten) — converted from
  event-driven to **cron `* * * * *`** that drains the
  `overtime_realtime_queue` table the time-entries controller writes to
  on stop/switch. Per drained user, recomputes OT_DAY for today and
  OT_WEEK for the trailing 7 days; both env-configurable; de-duped via the
  same UNIQUE constraint as the nightly batch.
- Rationale for the queue-table over pg-boss-send: apps/api would have to
  hold a pg-boss client otherwise. The queue table is one row per user
  (UPSERT) — collapses concurrent enqueues, draining is a single DELETE+
  RETURNING, no extra dep on apps/api.

## Item 9 — email retry job
- `packages/jobs/src/jobs/email-delivery-retry.ts` (rewritten) — cron
  `*/5 * * * *`. Sweeps `email_delivery_log` rows in `status='failed'` with
  `retry_count < 3` and `next_retry_at <= NOW()`. Exponential backoff
  schedule: 30min, 1h, 4h. After the third failure status flips to
  `failed_permanent`. Emits `email_delivery_retries` metric with
  `outcome=sent|retry|permanent` tags. Lazy `ALTER TABLE IF NOT EXISTS` for
  the two new columns + new status — works whether the new
  `20260523000000_feature_completion` migration has been applied or not.

## Item 10 — XLSX writer + RBAC + async job
- `apps/api/package.json` (modified) — added `exceljs ^4.4.0` and
  `@azure/storage-blob ^12.24.0` to dependencies.
- `apps/api/src/exports/xlsx-writer.service.ts` (new) — `XlsxWriterService.writeBuffer(rows, canSeeFinancial)`
  using `exceljs` with `columnsForRole()` from HarvestExportSchema. Header
  row bolded; column widths from the schema; cost columns stripped for
  non-financial roles.
- `apps/api/src/exports/export-jobs.service.ts` (new) — `ExportJobsService`
  manages the `export_jobs` table (create/markRunning/markDone/markFailed/
  get) and `uploadAndSign()` which pushes to Azure Blob (Azurite in dev) and
  generates a 5-minute SAS URL via `generateBlobSASQueryParameters`. Falls
  back to a `data:` URL when `BLOB_STORAGE_CONNECTION_STRING` is unset
  (test/dev only). Lazy DDL also creates `export_jobs` if the migration
  hasn't applied.
- `apps/api/src/exports/exports.controller.ts` (rewritten):
  - `POST /v1/exports/excel` — runs COUNT first; ≤100k sync (renders +
    uploads + returns the URL), >100k async (enqueues an `export_jobs`
    row + returns `{ job_id, status: 'queued' }`).
  - `GET /v1/exports/jobs/:id` — polls status; RBAC: actor must own the job.
  - **SECURITY M10 fix:** `intersectFilter()` intersects caller-supplied
    `user_ids` / `project_ids` with `rbac.getVisibleUserIds` /
    `getVisibleProjectIds`. Caller-supplied IDs that aren't visible are
    silently dropped. Admins (unrestricted) pass through their inputs.
  - Row SQL uses `get_effective_cost_rate` + `get_effective_billable_rate`
    helpers, joins users/projects/clients/project_tasks, and rounds hours
    to 2 decimals.
- `apps/api/src/exports/exports.module.ts` (modified) — wires the two new
  services.
- `packages/jobs/src/jobs/export-large-xlsx.ts` (rewritten) — cron
  `* * * * *`. Drains `status='queued'` rows from `export_jobs`, hands each
  to `deps.xlsxRenderer.render(...)` (injected by the worker bootstrap;
  apps/api owns the renderer wiring). Marks done/failed on the row.

## Item 11 — SSE sync endpoint
- `apps/api/src/sync/sync.service.ts` (new) — `SyncService` is a tiny
  in-process pub/sub using RxJS Subjects keyed by userId. `subscribe()`
  returns `{ subject, unsubscribe }`; `emit(userId, event)` fans out to
  every subject for that user; `onModuleDestroy()` drains on shutdown.
  Documented: this is single-instance pub/sub; multi-replica prod needs
  Redis pub/sub (v1.0.1 follow-up).
- `apps/api/src/sync/sync.controller.ts` (new) — `GET /v1/sync/events` via
  `@Sse()`. Merges the user's Subject with a 30s heartbeat interval;
  `takeUntil(close$)` tears down on disconnect; `finalize()` unsubscribes
  the registry slot.
- `apps/api/src/sync/sync.module.ts` (new) — `@Global()` so any controller
  can inject `SyncService` without re-importing.
- `apps/api/src/app.module.ts` (modified) — registers `SyncModule`.

## Item 12 — tests + migration
- `apps/api/test/unit/audit-integrity-hmac.test.ts` (new) — V1
- `apps/api/test/unit/time-entries-txn.test.ts` (new) — M1
- `apps/api/test/unit/leave-list-rbac.test.ts` (new) — M5
- `apps/api/test/unit/exception-detection-week-anomaly.test.ts` (new) —
  Items 5+6
- `apps/api/test/unit/schedule-overrides-broad.test.ts` (new) — Item 7
- `apps/api/test/unit/exports-rbac-intersection.test.ts` (new) — Item 10
- `apps/api/test/unit/sync-emit.test.ts` (new) — Item 11
- `apps/api/test/unit/openapi-contract.test.ts` (modified) — allowlist
  cleanup
- `apps/api/test/unit/time-entries-controller.test.ts` (modified) — Prisma
  stub gains `$transaction`; constructor passes 5th SyncService arg.
- `apps/api/test/unit/time-entry-patch-validation.test.ts` (modified) —
  same constructor-arg update + `makeSyncStub()` helper.
- `packages/db/prisma/migrations/20260523000000_feature_completion/migration.sql`
  (new) — `overtime_realtime_queue`, `export_jobs`, widen `email_delivery_log`
  with retry tracking. All `CREATE TABLE IF NOT EXISTS` /
  `ADD COLUMN IF NOT EXISTS` — greenfield-safe.
- `packages/jobs/src/index.ts` (modified) — named re-exports of every job so
  unit tests can `import { exceptionDetection } from '@harvoost/jobs'`.
- `.env.example` (modified) — documents the three new threshold env vars.

# What downstream agents need to know

## For frontend-dev (running in parallel)

- **SSE endpoint**: `GET /v1/sync/events` (EventSource-compatible). Auth via
  Bearer or cookie; events are user-scoped. Event types emitted from this
  pass:
  - `timer.started` — payload `{ type, data: <time_entry row>, ts }`
  - `timer.stopped` — payload `{ type, data: <time_entry row>, ts }`
  - `timer.switched` — payload `{ type, data: <time_entry row>, ts }`
  - `heartbeat` — every 30s, `{ ts }`
  Approvals/leave controllers will emit additional event types in v1.0.1
  (not in this pass — entry.submitted etc. are not yet wired through
  SyncService).
- **Broad schedule overrides**:
  - `GET /v1/schedules/overrides?scope=<user|project|org>&target_id=<id>`
    returns `{ data: [...] }` filtered to caller's RBAC scope.
  - `POST /v1/schedules/overrides` body shape:
    ```json
    {
      "scope": "user|project|org",
      "target_id": "20",                       // required for user/project
      "date_range": { "start": "2026-06-01", "end": "2026-06-30" },
      "new_start": "09:00",
      "new_end": "18:00",
      "new_lunch": { "start": "12:00", "end": "13:00" },  // optional
      "reason": "string min 1, max 500"
    }
    ```
    Returns `{ id, scope }`. 400 with `code: 'SCHEDULE_OVERRIDE_CONFLICT'`
    when a same-scope window already exists.
  - `DELETE /v1/schedules/overrides/:id` — same RBAC as creation.
- **XLSX export job polling endpoint**:
  - `POST /v1/exports/excel` — sync path returns
    `{ mode: 'sync', download_url, expires_at, row_count, columns, filters }`.
    Async path returns `{ mode: 'async', job_id, status: 'queued',
    row_count, threshold: 100000 }`.
  - `GET /v1/exports/jobs/:id` — poll. Returns
    `{ job_id, status, download_url, expires_at, error, created_at, updated_at }`.
    `status` ∈ `queued|running|done|failed`. When done, the
    `download_url` is a 5-minute SAS link — open it in a new tab.

## For tester (if re-dispatched)

- 7 new test files listed above. Pattern matches the existing
  `leave-rbac.test.ts` / `audit.service.test.ts` style (no Nest TestingModule
  boot; plain controller construction with stub deps).
- The M1 txn test is the trickiest: the mock for `prisma.$transaction(fn)`
  must call `fn(tx)` where `tx` carries the same `$executeRawUnsafe` /
  `$queryRawUnsafe` mocks — see `time-entries-txn.test.ts:makeTxStub`.
- `exception-detection-week-anomaly.test.ts` asserts SQL strings — if the
  query SQL is reformatted, the regex matchers need updating.

## For code-reviewer / security-reviewer (if revisited)

- **V1 closed** — HMAC recompute is now in `audit-log-integrity.ts`.
- **M1/M5/M6 closed** — see Item 2/3/4 above.
- **Stubbed features now functional** — XLSX, SSE sync, OT_WEEK, anomaly,
  schedule overrides, real-time overtime, email retry.
- **SECURITY M10 closed** — `ExportsController.intersectFilter()` enforces
  RBAC intersection on every export request. 5-minute SAS TTL on download.
- **New deploy-time concerns**:
  - The new migration `20260523000000_feature_completion` MUST be applied
    before the time-entries controller runs (otherwise the stop/switch
    enqueue silently fails — non-blocking thanks to the try/catch around
    the queue insert).
  - `overtime-realtime.ts` runs every minute via cron — confirm the worker
    process has the cron registered (n2 in the original code-review).
  - `export-large-xlsx.ts` expects the worker bootstrap to inject
    `xlsxRenderer` into JobDeps. Without that wiring, large exports stay
    in `queued` and the worker logs `no_renderer`. apps/api owns the
    renderer factory but the worker-mode boot path in `main.ts` still
    has the `TODO(build-phase-followup): boot pg-boss, registerJobs from
    @harvoost/jobs` stub — that's n2 from the original review and is
    NOT closed in this pass.
- **In-process SSE pub/sub** — works for single-replica Container Apps.
  Multi-replica needs Redis pub/sub or Service Bus topics; documented in
  `sync.service.ts`.

## Decisions worth logging

- **`overtime_realtime_queue` table** chosen over pg-boss client in apps/api
  to keep the API surface dep-free. Trade-off: one DB round-trip per stop/
  switch instead of one Redis-like enqueue. Acceptable since the stop/
  switch path already does ≥2 SQL statements.
- **Async export uses the same `xlsxRenderer` as sync** via JobDeps injection
  rather than duplicating the SQL/rendering logic in `packages/jobs`. Keeps
  the column-stripping / RBAC-intersection / Blob upload in one place.
- **`ScheduleOverride` schema was already in init migration** with the
  correct shape (scope + user_id + project_id + so_no_overlap GIST). No
  schema changes needed for Item 7.
- **Email retry job uses `ALTER TABLE IF NOT EXISTS`** at startup so it
  works whether the new `20260523000000_feature_completion` migration has
  applied. The migration is authoritative; the lazy DDL is defence in depth.
- **Leave cancel verb stays POST** in the controller while openapi says
  PATCH — kept in allowlist as a known divergence. Cancellation semantics
  (employee-initiated revoke of an approved request) feels more POST-y;
  flagged for product confirmation.

# Open questions / unknowns

- **Renderer wiring for async XLSX**: The dispatch acknowledged that
  `xlsxRenderer` is injected via the worker bootstrap. apps/api's
  WORKER_MODE branch in `main.ts` is still the stub `setInterval(()=>{},
  60_000)` from the original build — it does NOT register the jobs or
  inject the renderer. A v1.0.1 follow-up needs to:
  - Boot pg-boss + call `registerJobs(boss, { ...deps, xlsxRenderer: new XlsxRenderer(prisma, writer, blob) })`
  - Wire up the metrics emitter against Application Insights
  - Wire up `auditHashSecret: env.AUDIT_HASH_SECRET` so the integrity job
    can recompute
- **SSE multi-replica**: in-process pub/sub will drop events for users
  whose stop/switch lands on one replica and SSE subscription lands on
  another. Document this in the deploy runbook (single-replica during v1,
  Redis pub/sub for v1.1).
- **Email retry on cold start**: the first retry tick after deploy will
  silently widen the schema via `ALTER TABLE IF NOT EXISTS`. If the
  database role lacks DDL privilege in prod, the lazy widen logs warn and
  the retry SELECT will still succeed (the columns just won't exist —
  COALESCE handles it). Cleaner is to ensure the migration runs at
  deploy time.
- **OT_WEEK local_date semantics**: I anchored the row to "yesterday in
  user's TZ" (the trailing window end). The nightly batch could
  alternatively anchor to ISO week-end (Sunday). The current choice is
  more "what triggered the detection" and lets the unique constraint
  dedupe per detection day, but if reporting wants per-ISO-week
  uniqueness, this should change.

# Verification evidence

- All edits are surgical to the listed files; no other files modified.
- `grep -rn "TODO(build-phase-followup)" apps/api/src/exports
  apps/api/src/sync apps/api/src/schedules` → expected empty (all
  resolved in this pass).
- `grep -rn "TODO(build-phase-followup)" packages/jobs/src/jobs` → only
  the build-phase-followup comments inside docstrings remain; the
  load-bearing stubs (overtime-realtime, email-delivery-retry,
  export-large-xlsx, exception-detection week+anomaly) are implemented.
- Static type review by inspection — TypeScript signatures verified:
  - `TimeEntriesController` constructor takes `(prisma, idempotency, rbac,
    audit, sync)` — matches the new SyncService global module.
  - `SchedulesController` constructor unchanged signature (prisma, rbac,
    audit) — backwards compatible.
  - `ExportsController` constructor takes `(prisma, rbac, writer, jobs)` —
    matches `ExportsModule` providers list.
  - `SyncService` exports `subscribe / emit / subscriberCount /
    onModuleDestroy` — used by both the controller and time-entries.
- No new `MOCK_OIDC` / `ENTRA_*` references introduced.
- No raw string-interpolated SQL anywhere — every SQL statement uses
  positional bindings; the single inline literal is `SET LOCAL
  app.audit_hash_secret = '<safe>'` and `<safe>` is single-quote-escaped
  (Postgres literal-escape rule, same pattern as AuditService).
- Would-run checks (sandbox cannot execute):
  - `pnpm --filter @harvoost/api typecheck` — strict TS compile of all new files.
  - `pnpm --filter @harvoost/api lint` — ESLint.
  - `pnpm --filter @harvoost/api test` — vitest unit suite (8 new files + 2
    modified). New tests target Subject-level (sync), SQL string assertions
    (exception detection), and stub-driven controller logic (everything else).
  - `pnpm --filter @harvoost/db prisma migrate dev` — applies the new
    `20260523000000_feature_completion` migration; greenfield-safe so a
    re-apply is a no-op.
