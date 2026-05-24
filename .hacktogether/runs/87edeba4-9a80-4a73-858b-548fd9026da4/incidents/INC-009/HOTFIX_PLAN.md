# INC-009 — HOTFIX_PLAN — return project_name / task_name from time-entries reads

GitHub issue: #21 · Suggested implementer: **`backend-dev`** (no `frontend-dev` needed)

## Summary
The FE already renders `entry.project_name`/`entry.task_name` with safe fallbacks; the API
just never sends them. Add the `projects` (INNER) + `project_tasks` (LEFT) joins to the
time-entries READ paths, mirroring the existing pattern in `exports.controller.ts:223-225`
and `reports.controller.ts`. Smallest correct fix: the **list** and **running** SELECTs.
Optionally also enrich the **start/switch** return values for belt-and-suspenders, since the
FE re-fetches the list on success and the running row comes from the list/running endpoints.

## Files Changed

### 1. `apps/api/src/time-entries/time-entries.controller.ts` — REQUIRED
**`list()` SELECT (around lines 141-147).** Add the joins + name columns.
- Change the projection from:
  ```
  SELECT te.id, te.user_id, te.project_id, te.task_id, te.notes, te.start_at, te.end_at, te.status, te.billable
  FROM time_entries te
  WHERE ${wheres.join(' AND ')}
  ```
  to:
  ```
  SELECT te.id, te.user_id, te.project_id, p.name AS project_name,
         te.task_id, pt.name AS task_name,
         te.notes, te.start_at, te.end_at, te.status, te.billable
  FROM time_entries te
  JOIN projects p ON p.id = te.project_id
  LEFT JOIN project_tasks pt ON pt.id = te.task_id
  WHERE ${wheres.join(' AND ')}
  ```
- Keep `ORDER BY te.start_at DESC` and the `LIMIT $${limitIdx}::int`. The existing `wheres`
  all reference `te.*` so they remain valid under the alias.
- Rationale: the week table (`page.tsx:267-270`) is rendered from this endpoint; this single
  change makes the running row AND every other row show the project name + task name.

**`running()` SELECT (around lines 161-167).** Same join, against the `te` alias.
- Change from:
  ```
  SELECT id, user_id, project_id, task_id, notes, start_at, end_at, status, billable
  FROM time_entries
  WHERE user_id = $1::bigint AND status = 'running'
  LIMIT 1
  ```
  to:
  ```
  SELECT te.id, te.user_id, te.project_id, p.name AS project_name,
         te.task_id, pt.name AS task_name,
         te.notes, te.start_at, te.end_at, te.status, te.billable
  FROM time_entries te
  JOIN projects p ON p.id = te.project_id
  LEFT JOIN project_tasks pt ON pt.id = te.task_id
  WHERE te.user_id = $1::bigint AND te.status = 'running'
  LIMIT 1
  ```
- Rationale: fixes the `TimerBar` label (`TimerBar.tsx:129-130`). Not strictly required to
  close the reported `/timesheets` symptom, but it is the same defect and the same one-line
  pattern, so fix it together.

**`start()` / `switch()` RETURNING (lines ~198-208 / ~286-295).** OPTIONAL.
- `INSERT ... RETURNING` cannot JOIN, so to include names you must re-select the inserted row
  with the joins inside the same transaction, e.g. after the INSERT:
  ```
  const rows = await tx.$queryRawUnsafe(
    `SELECT te.id, te.user_id, te.project_id, p.name AS project_name,
            te.task_id, pt.name AS task_name, te.notes, te.start_at, te.end_at,
            te.status, te.billable, te.mood_score
     FROM time_entries te
     JOIN projects p ON p.id = te.project_id
     LEFT JOIN project_tasks pt ON pt.id = te.task_id
     WHERE te.id = <inserted id>`, ...);
  ```
  by capturing the inserted `id` from a first `RETURNING id`.
- DECISION: treat this as **optional / nice-to-have**, NOT required for #21. The FE start
  flow (`StartTimerControl.tsx:79-87`) discards the start response and re-fetches the list,
  so the rendered running row already gets its names from the fixed `list`/`running`
  endpoints. Implementer may skip start/switch to keep the diff minimal, OR enrich them so
  the `{ type: 'timer.started', data }` SSE payload (`controller.ts:226`) also carries names
  for future SSE-driven consumers. Document whichever choice is made.
- Do NOT change `normalizeRow` — it is a generic pass-through and correctly forwards any
  `project_name`/`task_name` columns the SQL now produces (it only strips cost fields).

### 2. `apps/api/test/e2e/time-entries-task-id.e2e.test.ts` — REQUIRED (test)
Extend this existing real-DB controller test (same fixtures: `EMPLOYEE` = carol/user 7,
`TEST_PROJECT_ID = '1'`, `TEST_TASK_ID = '1'` = the seeded "General" task). Add a describe
block, e.g. `time-entries read endpoints return project_name/task_name (INC-009, #21)`:
- Look up the seeded project name once:
  `SELECT name FROM projects WHERE id = $1::bigint` for project 1 (and `SELECT name FROM
  project_tasks WHERE id = 1` → expect "General"), guarded by the existing `dbReady` flag.
- `start` with `task_id = '1'`: assert `out.project_name === <seeded project name>` and
  `out.task_name === 'General'` (only if start/switch enrichment is implemented — otherwise
  omit this assertion and note the decision).
- `running` after a start: call `ctrl.running(EMPLOYEE)`, assert
  `res.data.project_name === <seeded name>` and `res.data.task_name === 'General'`.
- `list` after a start: call `ctrl.list(EMPLOYEE, { limit: 50 } as any)` (mirror the query
  shape the controller expects), assert the running row carries `project_name` and
  `task_name`.
- `task_name` is `null` when no task: start with project only (no `task_id`), assert
  `running`/`list` row has `task_name == null` and `project_name` still populated.
Follow the file's existing conventions: `if (!dbReady) { console.warn(...); return; }`
skip-guard, `String(...)`-based comparisons for bigint columns, and the `afterEach` cleanup.

## Tests to run (verification)
- `apps/api` real-DB e2e: the extended `time-entries-task-id.e2e.test.ts` (needs the seeded
  Postgres up — per harvoost-verify-baseline, use the live/real-DB test command, not
  `nest build`).
- `apps/web` unit: `feat001-timer-wiring.test.ts` + `feat002-list-envelope.test.ts` must stay
  green (they pin request shape / envelope, unaffected by added response fields).
- Optional manual/live-e2e: `tests/e2e/specs/feat001-timer-start.spec.ts` — after Start, the
  new row's Project cell shows the project name and Task shows the selected task (or "—" when
  none).

## Rollback
- `git checkout -- apps/api/src/time-entries/time-entries.controller.ts
   apps/api/test/e2e/time-entries-task-id.e2e.test.ts`
  (or revert the single hotfix commit). The change is additive to the SELECT projections
  only — reverting restores the prior id-only response with zero schema/migration impact
  (no DB changes are made by this fix).
