---
phase: 05-test
agent: tester
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
Regression + acceptance-coverage verification for FEAT-003 (GitHub #16, project
task management) across the whole monorepo. Ran the full per-package vitest suite,
verified every AC (AC-1..AC-8) maps to real behavioral tests, closed the one
coverage gap (AC-5 role guard) with 6 added tests driving the real `RolesGuard`
against the real `@Roles` metadata, and confirmed both touched packages typecheck
clean. The suite is green except for the single documented pre-existing
`@harvoost/shared` `RbacScopeService` failure — no regressions introduced by
FEAT-003.

# Files touched
- `apps/api/test/unit/project-tasks-controller.test.ts` (modified) — +6 tests
  (34 → 40): a new `task write routes — AC-5 @Roles(admin,finmgr) guard` describe
  block asserting the decorator metadata (`['admin','finmgr']`) on both new write
  methods and the real `RolesGuard`'s allow/deny behavior (admin ✓, finmgr ✓,
  employee 403, manager 403, no-user rejected). Added the `RolesGuard` / `Reflector`
  / `ROLES_KEY` / `RbacForbiddenError` imports needed for it.
- `.hacktogether/runs/.../FEAT-003/TEST_REPORT.md` (new) — `## Unit & Integration`
  section: per-package counts, AC→test map, tests added, regression line.

# Per-package results (all vitest)
- `@harvoost/api`    — 47 files, **425 pass**, 0 fail (was 419; +6 added here)
- `@harvoost/web`    — 16 files, **196 pass**, 0 fail
- `@harvoost/contract` — 1 file, **154 pass**, 0 fail
- `@harvoost/jobs`   — 7 files, **40 pass**, 0 fail
- `@harvoost/db`     — 2 files, **21 pass**, 0 fail
- `@harvoost/shared` — 8 files, **101 pass**, **1 fail** (KNOWN pre-existing)
- **Total: 937 pass + 1 known pre-existing fail.**

Typecheck: `@harvoost/api` and `@harvoost/web` both `tsc --noEmit` → exit 0, clean.

# What downstream agents need to know
- **regressions: none.** The only red test is the documented baseline
  `@harvoost/shared › RbacScopeService › throws RbacError on empty requesterId` —
  present on clean `main`, unrelated to FEAT-003, accepted per the verify-baseline
  memory note.
- **AC coverage is complete.** AC-1..AC-8 all map to real behavioral tests (see the
  TEST_REPORT AC→test table). AC-5's role-guard half was the one gap and is now
  covered by tests that exercise the real guard + real decorator metadata (no mock).
- **Contract count is 154, not the dispatch's 151.** `openapi.yaml` and the contract
  test files are unchanged by FEAT-003 (only `projects.controller.ts` changed among
  contract/openapi/controller files), so 154 is the pre-existing baseline and the
  dispatch's 151 is stale. Contract is fully green either way — not a regression.
- **AC-7 (the React Tasks drawer) is verified at the lib/contract seam**
  (`project-tasks.ts`), matching the repo's web-test convention (mocked-fetch lib
  tests; no component-render harness exists). All drawer-critical contracts (wire
  bodies, query-key invalidation, empty-body avoidance, duplicate-name error
  mapping) are pinned. If a future task wants DOM-level drawer assertions, a
  component-render harness (e.g. @testing-library/react) would need bootstrapping
  first — flagging, not doing, since it's beyond this task's scope.
- Backend's AC-6 decision stands and is tested as-built: duplicate active name →
  **HTTP 400** `{ code: 'VALIDATION_FAILED', details: { code: 'TASK_NAME_EXISTS' } }`
  (not 422/409). Frontend correctly narrows on `details.code` via
  `isTaskNameExistsError`; both sides are covered.

# Open questions / unknowns
- None blocking. (Optional follow-up only: a web component-render harness for true
  DOM-level AC-7 drawer tests — not required for FEAT-003.)

# Verification evidence
- `pnpm --filter @harvoost/api test` → 47 files, **425 passed (425)**.
- `pnpm --filter @harvoost/api test -- project-tasks-controller` → **40 passed** (was 34; +6 AC-5).
- `pnpm --filter @harvoost/web test` → 16 files, **196 passed (196)**.
- `pnpm --filter @harvoost/contract test` → **154 passed (154)**.
- `pnpm --filter @harvoost/jobs test` → **40 passed (40)**.
- `pnpm --filter @harvoost/db test` → **21 passed (21)**.
- `pnpm --filter @harvoost/shared test` → **101 passed, 1 failed** (known baseline `RbacScopeService` empty-requesterId).
- `pnpm --filter @harvoost/api typecheck` → exit 0, clean.
- `pnpm --filter @harvoost/web typecheck` → exit 0, clean.
- `nest build` NOT used (known repo gotcha — fails `TS6059` on clean main); `pnpm lint` NOT a gate (pre-existing ESLint v9 incompatibility). Both noted, not fixed.
- No git commit/push performed.

status: done
