# INC-009 — ROOT_CAUSE — start-timer row shows project ID not name; Task blank

GitHub issue: #21 · Severity: sev-3 (display/data-shape) · Scope: **backend response shape**

## Symptoms
On `/timesheets`, after clicking **Start Timer** the new running time-entry row renders
the **project ID** (`Project #<id>`) instead of the project **name**, and the **Task**
column is **blank** (`—`). Date and Notes render correctly; the entry persists fine.
The same defect also affects the running-timer label in the global `TimerBar`.

## Data-flow trace (no browser — code path)
1. `StartTimerControl` (`apps/web/src/components/StartTimerControl.tsx:79-87`) calls
   `startTimer()` then `queryClient.invalidateQueries({ queryKey: ['time-entries'] })`.
   It does NOT push an optimistic row — the started row only ever appears in the week
   table via a **refetch of the list query**.
2. The week table is rendered **exclusively** from the list query
   (`apps/web/app/timesheets/page.tsx:59-78`, `entries = entriesQuery.data?.data`),
   which hits `GET /v1/time-entries?user_id&date_from&date_to`. The running row is just
   one of those list rows (`status: 'running'`) — there is no separate "running-row"
   render path on this page.
3. The cells read (`page.tsx:267-270`):
   - Project: `entry.project_name ?? \`Project #${entry.project_id}\``
   - Task:    `entry.task_name ?? '—'`
4. Backend `GET /v1/time-entries` (`apps/api/src/time-entries/time-entries.controller.ts:141-147`)
   selects **only** `te.id, te.user_id, te.project_id, te.task_id, te.notes, te.start_at,
   te.end_at, te.status, te.billable`. There is **no JOIN to `projects` / `project_tasks`**,
   so the response never contains `project_name` or `task_name`.
5. `normalizeRow` (`time-entries.controller.ts:627-637`) is pure pass-through — it strips
   cost fields and stringifies dates; it does **not** add names.

→ Every list row therefore falls back to `Project #<id>` and `—`. The reporter perceives
this as "the new row" because on a fresh week the just-started running entry is the only
row in the table, so it is the only one they scrutinise — but the defect is uniform across
all rows from this endpoint.

## Hypotheses
- H1 — FE renders the wrong field on the optimistic/started row. **REJECTED.** There is no
  optimistic row; the page reads names off the list query, and the field it reads
  (`project_name`/`task_name`) is the correct intended field. `api-types.ts:59-61` already
  declares both as optional on `TimeEntry`.
- H2 — `GET /running` returns no names while the list does, causing a mismatch on the
  running row. **REJECTED as stated** (the page does not render from `/running` — `TimerBar`
  does), but the underlying observation is right: `/running` also omits names
  (`controller.ts:162`). The TimerBar label is broken for the same reason.
- H3 — The list/start/running SQL never joins names, so the API simply does not return
  `project_name`/`task_name`; the FE fallback (`?? \`Project #...\``, `?? '—'`) is exactly
  what fires. **CONFIRMED** — see evidence below.

## Confirmed root cause
The backend time-entries read/return SQL omits the project/task name JOINs that the
sibling controllers already use. Specifically:

- List: `time-entries.controller.ts:142` — `SELECT te.id, te.user_id, te.project_id,
  te.task_id, te.notes, te.start_at, te.end_at, te.status, te.billable` (no names).
- Running: `time-entries.controller.ts:162` — same column set (no names).
- Start `RETURNING`: `time-entries.controller.ts:201` (and Switch `:289`, Stop `:244`,
  manual create `:488`) — return raw ids only, no names.

The FE contract is already correct: `TimeEntry.project_name?` / `task_name?`
(`api-types.ts:59-61`) and the render-with-fallback at `page.tsx:267-270` + the TimerBar
at `TimerBar.tsx:129-130`. The names are simply never sent.

The canonical join pattern already exists elsewhere in the codebase and should be mirrored:
- `apps/api/src/exports/exports.controller.ts:223,225`:
  `JOIN projects p ON p.id = te.project_id` and
  `LEFT JOIN project_tasks pt ON pt.id = te.task_id`.
- `apps/api/src/reports/reports.controller.ts:169,176,279,297,593,596`:
  `p.name AS project_name`, `COALESCE(pt.name, '(no task)') AS task_name`.

(Aside, not the reported symptom: the list SQL also omits `hours`, so the Hours column
renders `—` for every list row — `tz.ts:46-49`. A running entry has no duration anyway, so
the reporter did not flag it; calling it out as an adjacent gap, optionally fixed in the
same JOIN pass via a computed duration, but NOT required to close #21.)

## Where the fix belongs
**Backend.** The names are genuinely absent from the API response; this is not a
render-the-wrong-field bug. Add the `projects` (INNER) + `project_tasks` (LEFT) joins to:
- the `list` SELECT (`:142`) — fixes the week table for ALL rows including the running one;
- the `running` SELECT (`:162`) — fixes the TimerBar label;
- the `start` / `switch` / `stop` `RETURNING` clauses cannot JOIN inside an
  `INSERT ... RETURNING`, so the cleanest mirror of the existing pattern is to re-select the
  freshly inserted row with the joins (or, since the FE already re-fetches the list on
  success, the start/switch return values are not on the render path — see HOTFIX_PLAN.md
  decision). The list + running joins alone fully close the reported symptom.

No frontend change is required — `page.tsx:267-270`, `TimerBar.tsx:129-130`, and the
`TimeEntry` type already consume `project_name`/`task_name` with safe fallbacks. Adding the
backend names makes the fallbacks stop firing.

## Verification (planned — see HOTFIX_PLAN.md)
- Extend `apps/api/test/e2e/time-entries-task-id.e2e.test.ts` (real-DB controller test;
  carol=user 7, project 1, task 1 "General") to assert `start`, `running`, and `list`
  responses include `project_name` (matching the seeded project name) and `task_name`
  (= "General"), and that `task_name` is `null` when no task is set.
- Existing `feat001-timer-wiring.test.ts` (FE) stays green — it pins request shape, not the
  name fields.

## Prevention recommendation
- Add a contract assertion (the e2e above) that every time-entry read endpoint returns
  `project_name`/`task_name`, so a future SELECT that drops the JOIN regresses a test.
- Longer term: a single shared `SELECT ... FROM time_entries te JOIN projects p ... LEFT
  JOIN project_tasks pt ...` projection (a view or a shared SQL fragment) so list / running /
  start-returning cannot drift apart again. Regenerating `api-types` from `openapi.yaml`
  (the TODO at the top of `api-types.ts`) would also have surfaced that `project_name` is
  declared by consumers but never emitted by the spec for these routes.
