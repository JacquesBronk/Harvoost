---
phase: FEAT-002
agent: frontend-dev (LANE 5 — frontend)
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Implemented L5 (frontend) for FEAT-002 Option F (period/timesheet approval
locking) against the now-real backend routes, staying entirely within
`apps/web/*`. Added `PERIOD_LOCKED` friendly-error messaging so 409s on
create/edit/move/start/switch/stop/delete surface a clear sentence (via the
shared `describeError` path the NewEntryForm + TimerBar already use) instead of
a raw code. Finished the Submit-week flow against the pinned
`{ submitted_ids, skipped }` response: it now reports how many entries were
submitted and, when entries were skipped, how many and why (running timer /
already submitted). Adopted `GET /v1/timesheet-periods/{iso_week}` (self) to
drive the Submit button enable/disable plus a "Week submitted/approved — locked"
badge + inline banner on `/timesheets`, all additively and resiliently (the
period query is `retry: false` and any error falls back to the prior
entries-only behavior — the page never breaks if the call fails). Wired the
admin unlock-week endpoint and surfaced a minimal admin-only "Unlock week" action
on the existing Approvals queue. All period logic lives in a new
`src/lib/timesheet-periods.ts` (API calls + extractable pure helpers), pinned by
a hermetic vitest suite.

# Files touched
- `apps/web/src/lib/api-client.ts` (modified — added `friendlyErrorMessages.PERIOD_LOCKED`)
- `apps/web/src/lib/api-types.ts` (modified — added `TimesheetPeriod`, `TimesheetPeriodStatus`, `TimesheetPeriodEntryCounts`, `TimesheetPeriodList`, `SubmitTimeEntryRequest`, `SubmitWeekResponse`, `SubmitSkipReason`, `UnlockWeekRequest`, `UnlockWeekResponse` per the pinned shapes)
- `apps/web/src/lib/timesheet-periods.ts` (new — `fetchPeriod` / `submitWeek` / `unlockWeek` API calls + pure helpers `isoWeekToken`, `isPeriodLocked`, `canSubmitWeek`, `periodLockBanner`, `summarizeSubmitResult`, `isValidUnlockReason`, and `ISO_WEEK_TOKEN_RE` / `UNLOCK_REASON_MIN` constants)
- `apps/web/app/timesheets/page.tsx` (modified — period-status query, locked badge + inline banner, Submit-week gating via `canSubmitWeek`, submit success/skipped feedback via `summarizeSubmitResult`, "New entry" disabled when locked)
- `apps/web/src/components/UnlockWeekButton.tsx` (new — admin-only modal affordance; reason ≥ 20 chars, does NOT self-gate — caller applies the role check)
- `apps/web/app/approvals/page.tsx` (modified — admin-only "Unlock week" action per queue row, gated on `isAdmin(useCurrentUser())` and `ISO_WEEK_TOKEN_RE`)
- `apps/web/__tests__/feat002-period-lock.test.ts` (new — 31 hermetic tests)

# What downstream agents need to know
- **Unlock-week affordance placement:** I put it on the existing **Approvals
  queue** (`apps/web/app/approvals/page.tsx`) as an admin-only "Unlock week"
  button per row (extra "Admin" column, only rendered when `isAdmin(user)`).
  No new page was created. The button only renders for rows whose `iso_week`
  is a well-formed `YYYY-Www` token (`ISO_WEEK_TOKEN_RE`), guarding against
  queue shapes that label the week differently; otherwise it shows `—`. The
  `UnlockWeekButton` itself does not self-gate on roles — the role check lives
  at the call site, so it can be dropped elsewhere safely with its own gate.
- **Submit-week feedback semantics:** clean submit → `toast.success`
  ("Submitted N entries"); partial (some skipped) OR zero submitted →
  `toast.warning` with the count + reasons ("Skipped 2 (1 entry is still
  running, 1 was already submitted). Stop any running timer to include it.").
  Submit invalidates BOTH `['time-entries']` and `['timesheet-period']` so the
  lock badge/banner and disabled Submit button reflect immediately.
- **Resilience:** the period query uses `retry: false`; on error `period` is
  `undefined` and the page silently falls back to the previous draft-only
  Submit gating with no banner — a flaky/absent period endpoint never breaks
  `/timesheets` (per the dispatch's "keep it additive and resilient").
- **`iso_week` token shape:** the period read/unlock URLs take the `YYYY-Www`
  token (e.g. `2026-W21`), built with Luxon `weekYear`/`weekNumber` so a
  late-December date in ISO-week-1 tokenizes into the next year correctly.
  The week LIST entry-counts response field (numeric `iso_week`) differs from
  this URL token (`YYYY-Www`) — both are typed.
- Did NOT touch `query-client.ts` retry logic, the OIDC flow, INC-001..007 /
  FEAT-001 wiring, or anything outside `apps/web/*`. The existing Submit-week
  button wiring was finished in place (not ripped out); it now calls the shared
  `submitWeek()` helper.

# Open questions / unknowns
- The Approvals queue `ApprovalQueueItem.iso_week` is assumed to be a `YYYY-Www`
  token (matches the pinned period URL shape). The unlock button is defensively
  gated by `ISO_WEEK_TOKEN_RE`, so if the queue ever emits a different label the
  affordance degrades to `—` rather than building a malformed unlock URL.
- The unlock-week / approvals queue shapes are not authoritative here
  (openapi.yaml is api-designer's L4) — types mirror the pinned HANDOFF_backend
  shapes. If L4's final schema field names differ, reconcile against the spec.

# Verification evidence
- `pnpm --filter @harvoost/web test` → **152 passed (12 files)** (baseline 121
  + 31 new in `feat002-period-lock.test.ts`); 0 failures, no regressions.
- `pnpm --filter @harvoost/web typecheck` → clean (exit 0).
