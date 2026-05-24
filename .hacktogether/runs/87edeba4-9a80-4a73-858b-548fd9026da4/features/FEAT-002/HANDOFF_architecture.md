---
phase: features/FEAT-002
agent: architect
started: 2026-05-24
finished: 2026-05-24
status: complete — awaiting gate (a) architecture approval
---

# Summary
Designed FEAT-002 (GitHub #6) as **Option F**: a real `timesheet_periods` entity with its own
lifecycle plus a "submit the week → approve the week → week is locked" workflow, grounded in the
actual Harvoost code. The period is a **derived-but-persisted** rollup of its entries' statuses — it
does NOT fork the existing per-entry two-stage approval machine (`approvals.controller.ts` stays the
transition engine; we add a `recomputePeriod` hook). Submit is delivered through the route the FE
already calls and openapi already specs (`POST /v1/time-entries/{id}/submit` with `scope=week`),
closing the INC-004 `KNOWN_ROUTE_GAP`. A new `PERIOD_LOCKED` (409) domain error, mirroring
`EntryLockedError`, is enforced in `createManual`, the PATCH-move vector, and defensively in
start/switch. Full design in `features/FEAT-002/DESIGN.md`.

# Files touched
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-002/DESIGN.md` (new)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-002/HANDOFF_architecture.md` (new)

# What downstream agents need to know
- **Data model:** new `timesheet_periods (id, user_id, iso_year, iso_week, week_start_date, status,
  submitted_at, submitted_by, manager_approved_at, final_approved_at, reopened_at, created_at,
  updated_at)`; `UNIQUE(user_id, iso_year, iso_week)`. **No `period_id` FK on `time_entries`** —
  the entry↔period link is computed from `(user_id, ISO-week-of-start_at-in-user-TZ)`, not stored.
  `time_entries.status` stays the source of truth; `period.status` is a derived rollup.
- **Migration is additive & non-destructive** — `CREATE TABLE IF NOT EXISTS`, no `ALTER time_entries`,
  no backfill (periods created lazily on first submit). Follows the `20260523000000_feature_completion`
  precedent.
- **DECISION — submit grain:** period-level submit via the existing per-entry route
  `POST /v1/time-entries/{entry_id}/submit` + `scope=week` (FE already calls it; openapi already specs
  it). Closes the `KNOWN_ROUTE_GAP`; does NOT add a new `/timesheet-periods/.../submit` URL.
- **DECISION — D4 admin override:** admin-unlocking ANY entry recomputes its period back to `open`
  (`reopened_at` set). **No new period-reopen endpoint** — clean because the period status is derived.
  Leave-DELETE and entry-DELETE unchanged.
- **Approval endpoints unchanged in contract** — manager/final/admin-unlock each gain an internal
  `recomputePeriod` call in their existing transaction. stage1≠stage2 invariant preserved untouched.
- **Contract reconciliation (for api-designer):** add `PERIOD_LOCKED` to openapi `ErrorCode` enum
  (`:3092`); **remove** `'POST /v1/time-entries/{param}/submit'` from `KNOWN_ROUTE_GAP`
  (`tests/contract/src/contract-spec.ts:194`) — the route becomes real.
- **Build lanes:** L1 db-migration, L2 shared-errors, L3 backend (submit + enforcement + recompute +
  read), L4 api-designer (openapi + contract), L5 frontend (PERIOD_LOCKED messaging + verify submit
  against the now-real route), L6 tests. File-ownership partition is in DESIGN.md §6 (no two lanes
  write the same file). Sequencing: L1+L2 → L3 → L4 ∥ L5/L6.
- **Decision-log candidates:** (1) Option F chosen — real period entity, derived status; (2) submit =
  per-entry route + scope=week (gap closed, not superseded); (3) D4 = recompute-on-admin-unlock, no new
  reopen endpoint; (4) no `period_id` FK on `time_entries` (computed link).

# Open questions / unknowns
- Ship the DB-level period-lock trigger now or track it (TOCTOU hardening)? Recommend track.
- "Unlock week" convenience for fully-`final_approved` weeks (loops existing per-entry unlock) — in
  FEAT-002 scope or follow-up? Recommend follow-up (preserves D4 smallest surface).
- Block DELETE of a draft entry inside a locked week? Recommend no; one-line add if the gate disagrees.
- Recompute the source week on a successful within-allowed cross-week PATCH-move? Recommend yes (cheap).
- (Full list in DESIGN.md §7.)

# Verification evidence
- Grounded in: `schema.prisma`, `time-entries.controller.ts` (createManual:300, PATCH:337/355,
  DELETE:394/403, start:151, switch:235, LOCKED_STATUSES:74), `approvals.controller.ts`
  (manager:46, final:84 w/ stage1≠stage2:96, admin-unlock:134), `errors/index.ts` (EntryLockedError:52),
  `http-exception.filter.ts:23`, `openapi.yaml` (submit:1277, SubmitTimeEntryRequest:3522,
  ErrorCode:3092, approvals:1804+), `contract-spec.ts` KNOWN_ROUTE_GAP:189, the FE submit call
  `apps/web/app/timesheets/page.tsx:61-71`, and the migration convention in
  `migrations/20260523000000_feature_completion/migration.sql`.
- No app code written, nothing executed (per architect boundaries).
- Design not self-approved — request peer/gate-(a) review.
