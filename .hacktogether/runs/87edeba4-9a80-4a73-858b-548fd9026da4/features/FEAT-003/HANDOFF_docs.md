---
phase: 08-docs (FEAT-003)
agent: changelog-writer
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
Appended ONE changelog entry for FEAT-003 (GitHub #16 — project task management)
under `## [Unreleased]` → `### Added`, immediately after the existing #6 bullet and
before the `### Fixed` section. The entry matches the established house style of the
#5/#6 entries: a lead sentence stating the gap + what's now possible with the
`([#16](url))` link, indented sub-bullets for the notable specifics (backend
endpoints/RBAC/audit, the admin Tasks panel, archive-not-delete + FK preservation,
validation/conflict handling with the `TASK_NAME_EXISTS` envelope, picker sync), and
a closing verification line. Every claim is grounded in the four FEAT-003 handoffs
(backend / frontend / test / review) — nothing invented. No other changelog entry was
touched. No git commit/push.

# Files touched
- `/mnt/c/Projects/Harvoost/CHANGELOG.md` (modified) — added one bullet (with
  sub-bullets) for FEAT-003 under `[Unreleased] › Added`.
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-003/HANDOFF_docs.md` (new) — this file.

# What downstream agents need to know
- **README NOT changed (intentional).** Per dispatch, README.md is setup/run-oriented
  and FEAT-003 is an internal admin feature; I reviewed whether any README section is
  now wrong and found none. README has no per-feature endpoint catalogue, no admin-UI
  page walkthrough, and no task-management content to drift — so there is nothing to
  correct. No speculative edit made.
- **Verification numbers in the entry come straight from HANDOFF_test.md**, which is
  the authoritative post-integration count: 937 pass + 1 known pre-existing
  `@harvoost/shared` `RbacScopeService` fail, no regressions (api 425, web 196,
  contract 154, jobs 40, db 21). Note: `@harvoost/contract` is **154** (test phase),
  not the 151 cited in the dispatch — the dispatch number was stale (the #6 entry's
  "151 checks" is its own historical snapshot and was left untouched). FEAT-003 does
  not change `openapi.yaml` or the contract test files, so 154 is the pre-existing
  baseline.
- **Duplicate-name status is documented as HTTP 400 (not 422/409)**, faithfully to the
  as-built backend + the recorded review Decision: the repo's `ValidationFailedError`
  convention is hardwired to 400 with the stable code nested at `details.code`
  (`TASK_NAME_EXISTS`), mirroring the `clients`/`billable-rates` constraint-mapping
  precedent the backend was told to follow. The entry states this explicitly (400,
  `details.code`, "matching the repo's existing constraint-mapping convention rather
  than the spec's nominal 422") rather than claiming spec-literal 422 — so the
  changelog is accurate to the shipped behavior, not the contract's nominal response.
- **No breaking changes.** FEAT-003 is purely additive: two new endpoints implementing
  an already-published contract (no migration, no schema change, no removed/renamed
  surface, GET path untouched). Correctly placed under `Added`, no `BREAKING` section.

# Open questions / unknowns
- None blocking. The one cross-doc discrepancy (contract count 154 vs the dispatch's
  151) is resolved in favour of the test handoff's measured 154; flagged above so the
  orchestrator can reconcile if it tracks that number elsewhere.

# Verification evidence
- Re-read `CHANGELOG.md` #5/#6 entries before writing → new entry matches their
  structure (gap sentence + `([#N](url))`, indented specifics, verification close) and
  comparable length.
- Cross-checked every factual claim in the entry against HANDOFF_backend.md
  (endpoints/verbs/status/roles/audit actions/`TASK_NAME_EXISTS` 400 envelope),
  HANDOFF_frontend.md (Tasks drawer UX, admin-only, picker queryKey invalidation,
  `details.code` narrowing), HANDOFF_test.md (937+1 counts, AC→test map, RolesGuard
  coverage), and HANDOFF_review.md (clean review, 0 blocking/critical, recorded
  Decision) → all consistent; no unsupported statements.
- Edit applied in place via the Edit tool (no full rewrite); only the single new bullet
  added, surrounding entries byte-for-byte unchanged.
