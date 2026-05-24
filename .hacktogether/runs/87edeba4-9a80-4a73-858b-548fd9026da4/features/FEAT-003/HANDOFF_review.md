---
phase: 06-review (FEAT-003)
agents: code-reviewer + security-reviewer
finished: 2026-05-24
status: complete — CLEAN
attempt: 1 of 2
---

# Summary
Both reviews CLEAN — 0 blocking, 0 critical. No auto-loop back to build. Approve for predeploy gate.
(Reviewer agents had Read/Grep/Glob only and could not write files; the orchestrator persisted
CODE_REVIEW.md and SECURITY_REVIEW.md from their returned content.)

# Findings rollup (all non-blocking)
- minor (code): dup-name returns HTTP 400 + details.code=TASK_NAME_EXISTS, not the spec's 422 — repo `ValidationFailedError` convention (clients/billable-rates precedent); FE narrows on details.code. → logged as a Decision.
- minor (sec): non-numeric path id → 500 not 404 — PRE-EXISTING, shared by getOne/listTasks; controller-wide fix only if desired.
- minor (sec): task `name` CSV-formula-injection is an out-of-scope export-boundary hardening note (don't restrict input).
- nits: name.max(200) stricter than contract (positive); dedicated task_archive audit action (positive).

# Decision to record
FEAT-003 duplicate-name uses HTTP 400 + details.code per repo convention, diverging from openapi.yaml's 422 response. Accepted (codebase-convention-over-contract). A literal 422/409 would require a new ConflictError across all constraint mappings — backlog, not FEAT-003.

# Verification basis
RBAC (global guards, @Roles, 401/403, 404-no-leak, cross-project IDOR closed), parameterized SQL, race-safe 23505 via partial unique index, archive-not-delete FK preservation, React-escaped output, .strict() schemas, picker queryKey invalidation (AC-8), corrected error-seam test. Test phase: 937 pass + 1 known pre-existing shared fail, no regressions.
