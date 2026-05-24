# Incident INC-009 — start-timer row shows project ID not name; task blank

**GitHub issue:** #21

## Reporter description (verbatim)
> On /timesheets, after clicking "Start Timer" the new running time-entry row shows the
> project **ID number** instead of the project **name**, and the **Task** column is blank.
> Date and Notes populate correctly.
> Repro: log in as an employee (e.g. bob@harvoost.local), go to /timesheets, pick a project
> from the dropdown, click Start, observe the new running entry row.
> Expected: Project column shows the project name (e.g. "Project Alpha"), Task column shows
> the selected task (e.g. "General").
> Actual: Project column shows the project ID, Task column is blank.

## Triage (orchestrator)
- **Severity:** sev-3 (cosmetic display defect; no data loss, no security impact — the entry is
  persisted correctly, only its rendered Project/Task labels are wrong).
- **Scope:** frontend only, `/timesheets` running/new-entry row rendering. Likely the
  start-timer response/optimistic row or the running-entry render path. Backend persistence
  (`POST /v1/time-entries/start`) is not implicated by the symptom.
- **Reproduction:** as reported (employee → /timesheets → pick project → Start).
- **Blast radius:** every user who starts a timer from `/timesheets` sees the wrong Project
  label + missing Task until the row is re-fetched from a list endpoint that joins names.
- **Rollback recommended:** **no.** The app is not cloud-deployed (deploy deferred — Path 1);
  this is a dev-stack cosmetic bug. No artifact to roll back to. Fix forward.

## Initial hypothesis
The optimistic / started-entry row renders `entry.project_id` (a bigint string) directly, or the
`POST /v1/time-entries/start` response (and/or `GET /v1/time-entries/running`) does not include
the joined `project_name` / `task_name` that the week-list rows rely on — so the freshly-started
row falls back to the raw id for Project and renders blank for Task until a full list refetch.
Related to FEAT-001 (timer wiring).

## Next step
Rollback not recommended → dispatch `debugger` to confirm root cause and write ROOT_CAUSE.md +
HOTFIX_PLAN.md (frontend-scoped; backend response shape only if the names are genuinely absent
from the contract).
