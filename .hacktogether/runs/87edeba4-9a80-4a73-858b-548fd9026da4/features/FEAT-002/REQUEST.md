# FEAT-002 — Period/timesheet approval locking (GitHub #6)

- **GitHub issue:** #6 (labeled `enhancement`)
- **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
- **Opened:** 2026-05-24
- **Flow:** feature loop (full gates) — light intake/design (product-analyst grounds in code) → gate (a) design approval → build/test → gate (b) push. Spun out of FEAT-001 (#5), where the UX gate decided to keep free dating and defer proper period locking to this issue.

## Verbatim request (issue #6)
> ## Problem
> There is no week/period-level "approved" lock. Approval is tracked **per entry** (`draft → submitted → manager_approved → final_approved`). Today a user can create a manual entry — or back-date one — into a period whose entries have already been **submitted/approved**, provided the new entry doesn't overlap an existing one (the only guard `createManual` applies is `end_at > start_at`, `≤24h`, and the GiST no-overlap check). This can quietly undermine an already-approved timesheet.
>
> `PATCH /v1/time-entries/:id` already blocks edits when an entry is in a locked status (`LOCKED_STATUSES = {submitted, manager_approved, final_approved}`), but **creation/back-dating into a locked period is not checked**.
>
> ## Desired behavior
> Introduce a period/timesheet approval-lock concept so that creating, back-dating, or editing entries **into an approved period** is rejected with a clear `4xx` (e.g. `VALIDATION_FAILED` / a dedicated `PERIOD_LOCKED` code).
> - Define what "period approved" means (per-user per-week? per-user per-pay-period?).
> - Enforce in `POST /v1/time-entries` (manual create) and on back-dated `POST /start` / `POST /switch`.
> - Future-dating remains allowed (the FEAT-001 leave / public-holiday case).
> - Tests + a clear error envelope.
>
> ## Out of scope / notes
> - Out of scope of #5 (FEAT-001 ships free back/future dating, protected only by the per-entry no-overlap guard, per the UX-gate decision).
> - Relates to the latent "Submit week" gap (`POST /v1/time-entries/{id}/submit`, a `KNOWN_ROUTE_GAP` from INC-004) — a real period-lock likely wants the submit/approval workflow wired first.

## Grounding (orchestrator, confirmed in code)
- `apps/api/src/time-entries/time-entries.controller.ts:74` — `LOCKED_STATUSES = {submitted, manager_approved, final_approved}` already exists and is enforced on PATCH (:355) and (presumably) DELETE (:403) via `EntryLockedError`, but NOT on `createManual` (:301) or on back-dated `start`/`switch`.
- The per-entry status machine exists; there is NO period/timesheet entity and NO `POST /v1/time-entries/{id}/submit` route (KNOWN_ROUTE_GAP).

## Key design questions for the product-analyst to frame (resolved at gate (a))
1. **Definition of "period approved"** — per-user per-ISO-week vs per-user per-pay-period vs "any locked-status entry exists in the target period". Pragmatic v1 likely: a period is "locked" for a user if it contains ≥1 entry in a LOCKED_STATUS.
2. **Scope vs the submit workflow** — lighter lock reusing the existing per-entry statuses (ships now, no new entity) vs introducing a real period/timesheet entity + wiring `POST submit`/approval (much larger). Recommend assessing both.
3. **Enforcement points** — `createManual`, back-dated `start`/`switch` (NOT future-dating). Confirm `PATCH`/`DELETE` already covered.
4. **Error envelope** — dedicated `PERIOD_LOCKED` code vs reuse `VALIDATION_FAILED`.
5. **Scope assessment** (REQUIRED): structural change? API contract change? migration?
