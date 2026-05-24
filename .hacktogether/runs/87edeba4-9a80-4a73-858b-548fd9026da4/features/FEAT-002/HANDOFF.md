---
phase: features/FEAT-002 (light intake / design grounding)
agent: product-analyst
started: 2026-05-24
finished: 2026-05-24
status: complete — ready for gate (a)
---

# Summary
Grounded FEAT-002 (period/timesheet approval locking, GitHub #6) in the actual code and produced a
decision-ready `FEATURE_PLAN.md`. The feature closes a real write-into-an-approved-week hole. The
recommended approach (Option L) reuses the existing per-entry `LOCKED_STATUSES` + `time_entries` rows
to treat a per-user ISO-week as "locked" when it already contains a submitted/approved entry — no new
table, no migration, one additive `PERIOD_LOCKED` (409) error code, and internal pre-write checks on
the existing handlers. The fuller alternative (Option F: real period entity + wiring the deferred
submit workflow) is framed and assessed but recommended as a tracked follow-up, not this feature.

# Files touched
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-002/FEATURE_PLAN.md (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-002/HANDOFF.md (new)

# What downstream agents need to know
- **Scope verdicts (Option L, recommended):** structural change = NO; API change = YES (additive only —
  one new `PERIOD_LOCKED` enum value in `packages/shared/src/errors/index.ts` + `openapi.yaml` ErrorCode
  schema; NO new endpoint, NO new request/response shape); migration = NO.
- **The load-bearing fixes are `createManual` (time-entries.controller.ts:300) and the PATCH-move hole**
  (`:337`). The issue's mention of "back-dated start/switch" is mostly forward-looking: `start`/`switch`
  insert `start_at = NOW()` (`:175`,`:256`) so they cannot back-date today — add the check there
  defensively, but it is a no-op in practice. The genuine unguarded vector is a PATCH that moves an
  entry's `start_at`/`end_at` into a week containing OTHER locked entries (the existing `ENTRY_LOCKED`
  check at `:355` only inspects the entry's OWN status, not the destination week).
- **PATCH/DELETE already enforce `EntryLockedError` for the entry's own locked status — confirmed**
  (`:355`, `:403`). Keep those; the period check is additive and the own-status check fires first.
- **Admin override already exists per-entry:** `POST /v1/approvals/admin-unlock/:entryId`
  (approvals.controller.ts:135) flips one entry to `draft` with an audited ≥20-char reason. Under
  Option L, unlocking the locking entries auto-reopens the week — no new override needed for v1.
- **Submit is a real gap:** `POST /v1/time-entries/{id}/submit` is declared in openapi (`:1277`) but
  NOT implemented — it is the INC-004 `KNOWN_ROUTE_GAP` (`tests/contract/src/contract-spec.ts:189`).
  Option L does NOT depend on it. Option F would close it.
- **Timezone source for ISO-week computation:** `User.timezone` (schema.prisma:40, default
  Europe/Amsterdam), with `OrgSetting.defaultTimezone` fallback. The codebase already speaks ISO weeks
  (MoodWeeklyAggregate; the submit op's week-scope definition).
- **Decisions for the orchestrator to run gate (a):** D1 granularity (ISO-week, user-TZ — recommended),
  D2 lighter-vs-fuller (Option L — recommended), D3 error code (`PERIOD_LOCKED` — recommended), D4
  admin-override + DELETE scope (reuse per-entry admin-unlock, DELETE unchanged — recommended). All
  four [ASSUMED:] defaults are listed at the foot of FEATURE_PLAN.md for the Decision log.

# Open questions / unknowns
- The four gate-(a) decisions (D1–D4) above are the only open items; defaults are recommended and
  marked [ASSUMED:]. No blockers.
- Known low-severity TOCTOU race between the lock SELECT and the INSERT under Option L (a parallel
  submit landing mid-write) — acceptable for v1, flagged; a DB trigger is the Option-F-grade hardening.

# Verification evidence
- Read time-entries.controller.ts → confirmed LOCKED_STATUSES (:74), createManual unguarded (:300),
  PATCH own-status check only (:355), DELETE own-status check (:403), start/switch insert NOW() (:175,:256).
- Read approvals.controller.ts → confirmed two-stage machine + existing per-entry admin-unlock (:135).
- Read packages/shared/src/errors/index.ts → confirmed ErrorCode enum + EntryLockedError 409 pattern.
- Read apps/api/src/common/filters/http-exception.filter.ts → confirmed any DomainError auto-maps to
  {code,message,details}; no filter change needed for a new code.
- Grep schema.prisma → confirmed NO period/timesheet table exists (28 tables, none model a period).
- Read openapi.yaml :1277 (submit op declared) + grep contract-spec.ts:189 → confirmed submit is the
  KNOWN_ROUTE_GAP (declared, unimplemented). Contract test does NOT assert the ErrorCode enum, so adding
  PERIOD_LOCKED is non-breaking.
