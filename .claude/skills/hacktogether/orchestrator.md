# HackTogether orchestrator playbook (new_system mode)

This file is loaded by SKILL.md after a fresh run is created in new_system mode. It walks the linear DAG, dispatching subagents and honoring gates.

## State invariants

At every point during a run:
- `RUN_STATE.md` reflects the current truth: which phase is active, what's done, what's awaiting HITL.
- The current phase's folder under `.hacktogether/runs/<run_id>/` contains its artifacts.
- Every completed phase has a `HANDOFF.md` (or aggregated handoffs for parallel phases).

## Phase sequence (new_system mode)

For each phase below, in order:

1. Update RUN_STATE.md: set `current_phase`, mark the phase row as `▶ running`, append a Decision-log line "phase X started at <iso8601>".
2. Load the phase's sub-command file (one of `phases/*.md`, `gates/*.md`) and follow its instructions to dispatch the subagent(s) via Task.
3. When the dispatch returns (HANDOFF.md present on disk):
   a. Mark the phase row `✓ done` and fill the `artifacts` column with the primary deliverable path.
   b. Append any "What downstream agents need to know" notes from the HANDOFF as Decision-log entries.
4. If the next item is a gate:
   a. Update RUN_STATE.md `status` to `awaiting_hitl`.
   b. Load the gate file and follow it.
   c. On approval, write the gate's APPROVAL artifact and revert `status` to `in_progress`.
   d. On revise: re-dispatch the prior phase's subagent with the user's feedback in the prompt; re-enter step 3.
   e. On restart: mark the prior phase failed; ask user how to proceed.

## Sequence for new_system mode

```
intake                           → phases/intake.md
↓ gate                           → (intake is its own interview; no separate gate file)
architecture                     → phases/architecture.md
↓ gate                           → gates/approve_architecture.md
api_design                       → phases/api_design.md
↓ gate                           → gates/secrets_intake.md
build                            → phases/build.md
test                             → phases/test.md
review                           → phases/review.md
  ↳ if blocking findings + attempt ≤ 2 → phases/build.md with --scope 06-review/FIX_PLAN.md → loop to test → re-enter review
  ↳ if attempt > 2 → surface to user, halt
↓ gate                           → gates/predeploy_signoff.md
deploy                           → phases/deploy.md
docs                             → phases/docs.md
→ run complete: set RUN_STATE.md status=complete, print summary
```

## Dispatch template

When dispatching a subagent via Task, use this exact prompt structure (adapt per phase):

> You are the `<agent-name>` agent. The current run is `<run_id>` (slug: `<slug>`).
> Your assigned phase folder is `.hacktogether/runs/<run_id>/<phase-folder>/`.
> Required context to load first (in this order):
> - `.hacktogether/runs/<run_id>/RUN_STATE.md`
> - `.hacktogether/runs/<run_id>/PROMPT.md`
> - `<phase-specific context paths>`
>
> Your deliverables:
> - `<artifact-1>`
> - `<artifact-2>`
> - `HANDOFF.md` (using the template at `.claude/skills/hacktogether/templates/HANDOFF.md.tpl`)
>
> Do not modify files outside the project working directory and your phase folder.
> Do not call the orchestrator back. Write HANDOFF.md and exit.

The phase sub-command files (`phases/<name>.md`) specify the exact context paths and artifacts per phase — you do not need to invent them.

## Updating RUN_STATE.md

Use the Edit tool for surgical updates. Never re-write the whole file. The phase rows live in a single markdown table; identify the row by its `#` column.

## Error handling

- If a subagent's HANDOFF.md has `status: blocked` — append the blockers to RUN_STATE.md's "Open items" section, set run status to `failed`, halt. Do not proceed to the next phase.
- If a subagent's HANDOFF.md has `status: partial` — log it in Decision log; proceed if downstream phases can tolerate it (judgment call; ask the user if unsure).
- If the Task dispatch errors (subagent didn't write HANDOFF.md, tool error, etc.) — append the error to RUN_STATE.md Decision log, set status to `failed`, halt.
