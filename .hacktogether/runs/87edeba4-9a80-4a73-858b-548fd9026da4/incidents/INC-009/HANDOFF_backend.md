---
phase: incidents/INC-009
agent: backend-dev
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
INC-009 (GitHub #21): the time-entries READ endpoints returned only raw FKs, so the web
week table and the global TimerBar fell back to `Project #<id>` / `—` instead of the real
project + task names. Backend-only fix: added the canonical `projects` (INNER) +
`project_tasks` (LEFT) joins to the `list()` and `running()` SELECTs in
`time-entries.controller.ts`, mirroring `exports.controller.ts:221-225`. `normalizeRow` is a
pass-through and now forwards the new `project_name`/`task_name` columns unchanged. No FE
change is needed — the consumers already read those fields with safe fallbacks. Extended the
existing real-DB e2e test with an INC-009 describe block; all assertions ran against the
seeded dev Postgres and pass.

# Files touched
- `apps/api/src/time-entries/time-entries.controller.ts` (modified)
- `apps/api/test/e2e/time-entries-task-id.e2e.test.ts` (modified)

## Exact SELECT changes

`list()` — projection + joins (the WHERE/ORDER BY/LIMIT on the `te` alias are untouched):
```sql
SELECT te.id, te.user_id, te.project_id, p.name AS project_name,
       te.task_id, pt.name AS task_name,
       te.notes, te.start_at, te.end_at, te.status, te.billable
FROM time_entries te
JOIN projects p ON p.id = te.project_id
LEFT JOIN project_tasks pt ON pt.id = te.task_id
WHERE ${wheres.join(' AND ')}
ORDER BY te.start_at DESC
LIMIT $${limitIdx}::int
```

`running()` — same joins + name columns; table re-aliased to `te` and WHERE re-qualified to
`te.user_id` / `te.status` (this also fixes the TimerBar label — same defect, same one-liner):
```sql
SELECT te.id, te.user_id, te.project_id, p.name AS project_name,
       te.task_id, pt.name AS task_name,
       te.notes, te.start_at, te.end_at, te.status, te.billable
FROM time_entries te
JOIN projects p ON p.id = te.project_id
LEFT JOIN project_tasks pt ON pt.id = te.task_id
WHERE te.user_id = $1::bigint AND te.status = 'running'
LIMIT 1
```

# What downstream agents need to know
- **DECISION — SKIPPED the optional start()/switch() RETURNING enrichment** (HOTFIX_PLAN
  §1.3 / ROOT_CAUSE "where the fix belongs"). The FE start flow discards the start response
  and re-fetches the list (`StartTimerControl.tsx:79-87`), so the rendered running row gets
  its names from the now-fixed `list`/`running` endpoints. Keeping the diff minimal. The
  `timer.started` SSE payload therefore still omits names — no current SSE consumer renders
  names off it, but a future one would need the same re-select-with-joins pattern.
- **Scope guard honored**: the list SELECT still omits `hours` (Hours renders `—`). Per the
  dispatch this is OUT OF SCOPE for INC-009 and was deliberately NOT added — tracked
  separately. Only `project_name`/`task_name` were added.
- **Test-infra fixes required to make the real-DB assertions actually execute** (both are
  test-only, no production impact, and both are pre-existing conditions of the committed
  test against this seeded DB):
  1. The committed e2e file (FEAT-001 suite too) was already FAILING in its `beforeAll`
     cleanup with `42P01 relation "idempotency_keys" does not exist` — the seeded dev DB
     doesn't pre-create that table (the IdempotencyService creates it lazily on first
     lookup/store, but the cleanup DELETE runs first). Verified this fails identically on the
     unmodified `HEAD` version of the file. Added a defensive `CREATE TABLE IF NOT EXISTS
     idempotency_keys` (the service's own DDL) to both `beforeAll` blocks before the cleanup.
  2. `list()` calls `this.rbac.withSelfScope(userId)`, which the test's `makeRbac()` stub
     didn't implement. Added `withSelfScope: (userId) => ({ userIds: [userId], selfOnly: true })`
     to the stub (matching `RbacScopeService.ts:203`).
  Net effect: the previously-skipping/erroring FEAT-001 suite now runs green too (a bonus
  repair of a latent test-env break), and the new INC-009 assertions execute, not skip.
- `normalizeRow` untouched (confirmed pass-through; only strips cost fields).

# Open questions / unknowns
- None. The fix is additive to the SELECT projections only — zero schema/migration impact,
  trivially reversible by `git checkout` of the two files.

# Verification evidence
- `DATABASE_URL='postgresql://harvoost:dev@localhost:5432/harvoost?sslmode=disable' pnpm
  --filter @harvoost/api test:e2e time-entries-task-id` → **7 passed / 7** (1 file). NOTE:
  the `test:e2e` script (not `test`) is the one that includes `test/e2e/**` per
  `vitest.e2e.config.ts`; the plain `test` script's include globs only `test/unit/**` +
  `src/**`. Verbose run confirms the 4 new INC-009 assertions executed (NO `[skip]` warning,
  `dbReady` was satisfied — the seeded Postgres at localhost:5432 was reachable):
  - `... INC-009 ... > seeded task 1 is "General"` ✓
  - `... INC-009 ... > running() returns project_name + task_name after a start with a task` ✓
  - `... INC-009 ... > list() running row carries project_name + task_name` ✓
  - `... INC-009 ... > task_name is null when started with no task, project_name still populated` ✓
  (asserts running()/list() return `project_name === <seeded project 1 name>`,
  `task_name === 'General'` with a task, and `task_name === null` / `project_name` populated
  without a task.)
- `pnpm --filter @harvoost/api test` (full api suite) → **425 passed / 425** (47 files). No
  regressions.
- `pnpm --filter @harvoost/api typecheck` → clean (tsc exit 0, no output). NOTE: tsconfig
  excludes `test/`, so the controller `src` change is type-checked; the test edits were
  type-validated by the passing vitest transpile+run above.
- `pnpm --filter @harvoost/web test feat001-timer-wiring feat002-list-envelope` (FE request-
  shape / envelope pins from the plan) → **26 passed / 26** (2 files). Unaffected by the
  added response fields, as expected.
- Did NOT run `nest build` (known-broken repo-wide per verify baseline). Did NOT git
  commit/push.

status: done
