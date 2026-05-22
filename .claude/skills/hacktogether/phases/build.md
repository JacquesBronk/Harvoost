# Phase: build

Subagents: `backend-dev` + `frontend-dev` + `database-admin` (3-way), OR `coder` (monolith fallback), OR scoped subset (--scope mode).
Phase folder: `.hacktogether/runs/<run_id>/04-build/`
Inputs: `01-intake/REQUIREMENTS.md`, `02-architecture/ARCHITECTURE.md`, `02-architecture/STACK.md` (Modules + Data flow sections), `03-api-design/openapi.yaml` (if exists), `03-api-design/API_NOTES.md` (if exists)
Outputs: `04-build/backend/HANDOFF.md`, `04-build/frontend/HANDOFF.md`, `04-build/db/HANDOFF.md` — plus implementation code in `src/`, tests in `tests/`, etc.

## Mode selection

Inspect `02-architecture/STACK.md`:
- If STACK.md declares a **monolith** structure (single executable, no separation of frontend/backend/db): dispatch `coder` as a single lane. Skip 3-way fan-out.
- Else: 3-way fan-out (backend-dev, frontend-dev, database-admin).

## Scope check (--scope mode)

If your invocation prompt includes `--scope <plan-file>` (used for review-loop fixes and hotfixes):
- Load `<plan-file>` (e.g., `06-review/FIX_PLAN.md` or `incidents/INC-NNN/HOTFIX_PLAN.md`).
- Identify the affected modules from the plan's "Affected files" / "Suggested agent" sections.
- Dispatch ONLY the relevant subagent(s), with the plan file path included in their prompt.
- Skip subagents whose modules are not in scope.

## Pre-dispatch

Update RUN_STATE.md: row #4 (build) → `▶ running`. In the agent(s) column, list which subagent(s) you're dispatching this run.

## Dispatch prompts

For **backend-dev** (full build):

> You are the `backend-dev` agent. The current run is `<run_id>`.
> Your assigned phase folder is `.hacktogether/runs/<run_id>/04-build/backend/`.
> Required context:
> - `.hacktogether/runs/<run_id>/RUN_STATE.md`
> - `.hacktogether/runs/<run_id>/01-intake/REQUIREMENTS.md`
> - `.hacktogether/runs/<run_id>/02-architecture/ARCHITECTURE.md` (Modules + Data flow sections)
> - `.hacktogether/runs/<run_id>/02-architecture/STACK.md`
> - `.hacktogether/runs/<run_id>/03-api-design/openapi.yaml` (if exists)
> - `.hacktogether/runs/<run_id>/03-api-design/API_NOTES.md` (if exists)
>
> Implement the backend per the OpenAPI contract and STACK.md. Use TDD: failing test first, minimum code to pass, refactor, repeat. Place code under `src/api/` (or stack-appropriate path) and tests under `tests/api/`. Do NOT implement frontend or database concerns — those have separate lanes.
>
> After implementation, write `04-build/backend/HANDOFF.md` listing files touched, what downstream lanes need to know (especially any deviations from openapi.yaml), and verification evidence (test command + result).
>
> Exit after writing HANDOFF.md.

For **frontend-dev** (full build):

> [Same shape as backend, but: implement UI under `src/ui/` or `web/` per STACK.md; tests under `tests/ui/`. Do NOT implement backend or database. Reference openapi.yaml for endpoint shapes.]

For **database-admin** (full build):

> [Same shape: produce migrations under `migrations/` or `db/migrations/` per STACK.md; ensure schema supports endpoints described in openapi.yaml. Do NOT implement application code. Write a schema diagram to `04-build/db/HANDOFF.md`.]

For **coder** (monolith fallback):

> You are the `coder` agent dispatched as the monolith builder. Your assigned phase folder is `.hacktogether/runs/<run_id>/04-build/`. You produce the ENTIRE codebase in one lane: backend, frontend (if any), database, all in one coherent module structure. [Otherwise same context list as above; write HANDOFF.md to `04-build/HANDOFF.md`.]

## Parallel fan-out (3-way, full build)

Issue a SINGLE assistant message containing THREE concurrent Task tool calls — one for backend-dev, one for frontend-dev, one for database-admin. Each uses the dispatch prompt from above for its lane.

Wait for all three HANDOFF.md files to be present on disk before proceeding. Check after the parallel Task calls return:

```bash
ls .hacktogether/runs/<run_id>/04-build/backend/HANDOFF.md \
   .hacktogether/runs/<run_id>/04-build/frontend/HANDOFF.md \
   .hacktogether/runs/<run_id>/04-build/db/HANDOFF.md
```

If any lane's HANDOFF.md is missing after the parallel Task calls return, that lane failed silently — surface to user and halt.

For monolith mode (coder lane), no fan-out: single Task dispatch, single HANDOFF.md.

For --scope mode, only dispatch the lanes referenced in the plan file; others are skipped.

## Post-dispatch

1. Verify all expected HANDOFF.md files exist (backend, frontend, db — or just `04-build/HANDOFF.md` for monolith).
2. Aggregate: any HANDOFF with `status: blocked` → halt, update RUN_STATE.md row #4 to `⚠ blocked`, log blockers, return failure to orchestrator.
3. Else: update RUN_STATE.md row #4 → `✓ done`, artifacts column → `04-build/*/HANDOFF.md`.
4. Return control — orchestrator advances to `phases/test.md`.
