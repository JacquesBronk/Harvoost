---
phase: incidents/INC-009
agent: debugger
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Traced the start-timer → week-table render path for INC-009 (#21) entirely in code (no
browser). Root cause is a **backend response-shape gap**, not a frontend render bug: the
time-entries READ endpoints (`GET /v1/time-entries` list and `GET /v1/time-entries/running`,
plus the start/switch/stop `RETURNING` clauses) `SELECT` only raw `project_id`/`task_id` and
**never JOIN `projects` / `project_tasks`**, so they never emit `project_name`/`task_name`.
The FE already renders `entry.project_name ?? \`Project #${id}\`` and `entry.task_name ?? '—'`
(timesheets `page.tsx:267-270`, `TimerBar.tsx:129-130`) with the right field + safe fallbacks
— so every list row (the running row included; the page has no separate running-row path and
no optimistic row) falls back to the id and a blank task. The reporter notices it on the
just-started row because on a fresh week that is the only row present. Fix belongs in the
backend: add the `JOIN projects p` + `LEFT JOIN project_tasks pt` name columns to the list +
running SELECTs (start/switch enrichment optional), mirroring the existing pattern in
`exports.controller.ts:223-225` and `reports.controller.ts`. No FE change needed.

# Files touched
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-009/ROOT_CAUSE.md (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-009/HOTFIX_PLAN.md (new)
- (no product code edited — investigation only)

# What downstream agents need to know
- Implementer is **`backend-dev`** only; `frontend-dev` is NOT required (the `TimeEntry` type
  and both render sites already consume `project_name`/`task_name`).
- The REPORT's premise that "the week-list rows DO show names while only the started row
  doesn't" is INACCURATE — the time-entries controller has no name JOIN anywhere, so ALL rows
  from this endpoint fall back to the id. The fix to the list SELECT corrects every row at once.
- Smallest correct fix = list SELECT (`controller.ts:142`) + running SELECT (`:162`). The
  start/switch `RETURNING` cannot JOIN inside `INSERT ... RETURNING`; enriching them needs a
  re-select and is OPTIONAL because the FE re-fetches the list on start success — flagged as a
  decision for the implementer (skip to keep the diff minimal, or enrich so the SSE
  `timer.started` payload also carries names).
- Adjacent (not in scope for #21): the list SELECT also omits `hours`, so the Hours column
  renders `—` for every list row. Noted in ROOT_CAUSE.md; not required to close #21.
- Test home already exists: extend `apps/api/test/e2e/time-entries-task-id.e2e.test.ts`
  (real-DB controller test, carol=user 7 / project 1 / task 1 "General") to assert the new
  name fields. Per memory's verify baseline, run via the real-DB/live test path, NOT `nest build`.

# Open questions / unknowns
- Whether to also enrich start/switch return values (and thus the SSE payload) — left as an
  explicit implementer decision in HOTFIX_PLAN.md; not needed to close the reported symptom.

# Verification evidence
- grep `project_name|task_name` across `apps/api/src/time-entries/` → no matches (controller
  never references the name fields → confirms they are never selected/returned).
- `time-entries.controller.ts:142` (list) and `:162` (running) → SELECT lists contain only
  `project_id`/`task_id`, no JOIN to projects/project_tasks.
- `exports.controller.ts:223,225` + `reports.controller.ts:169,176,279,297,593,596` → the
  canonical `JOIN projects p ... LEFT JOIN project_tasks pt ...` / `p.name AS project_name`,
  `COALESCE(pt.name,'(no task)') AS task_name` pattern the fix should mirror.
- `apps/web/app/timesheets/page.tsx:59-78,267-270` → page renders solely from the list query;
  reads `project_name`/`task_name` with id/`—` fallbacks; no optimistic row.
- `apps/web/src/lib/api-types.ts:59-61` → `TimeEntry.project_name?`/`task_name?` already
  declared (FE contract already correct).
