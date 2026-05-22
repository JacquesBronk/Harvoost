# Gate: approve_architecture

Trigger: after `phases/architecture.md` completes.
Halts: until user replies `approve`, `revise <feedback>`, or `restart`.
Outputs: `.hacktogether/runs/<run_id>/02-architecture/APPROVAL.md` (on approve).

## Pre-gate

Update RUN_STATE.md: `status: awaiting_hitl`, `current_phase: gate:approve_architecture`.

## Surface the prompt to the user

Read `02-architecture/ARCHITECTURE.md` and extract:
- The chosen stack (one-line summary)
- The "Concerns / flags for HITL approval" section
- Any `[ASSUMED:]` items the architect carried forward

Print to the user:

> ★ HITL — architecture approval
>
> Architect proposes: **<stack one-liner>**
>
> Concerns flagged for your review:
> - <concern 1>
> - <concern 2>
>
> Assumptions:
> - <assumed item, or "none">
>
> Reply with one of:
> - `approve` — proceed to api_design
> - `revise <feedback>` — re-run architecture with your feedback included
> - `restart` — abort and return to intake

## Response handling

On `approve`:
1. Write `02-architecture/APPROVAL.md`:
   ```markdown
   ---
   gate: approve_architecture
   approved_by: <user identity if known, else "user">
   approved_at: <iso8601>
   ---
   Approved as-is. Architect's flagged concerns acknowledged.
   ```
2. Update RUN_STATE.md: `status: in_progress`, gate column for row #2 → `✓ approved`.
3. Append Decision-log: `<iso8601> architecture approved`.
4. Return control — orchestrator advances to `phases/api_design.md`.

On `revise <feedback>`:
1. Append the feedback to `02-architecture/ARCHITECTURE.md` under `## Revision request <N>`.
2. Re-dispatch the `architect` subagent via `phases/architecture.md`'s dispatch prompt, but add to the prompt: "Revise per the feedback at the bottom of ARCHITECTURE.md."
3. When the agent finishes, re-enter this gate from the top.

On `restart`:
1. Mark RUN_STATE.md row #2 as `✗ restarted`, status `failed`.
2. Surface to user: "Architecture restarted. Re-run `/hacktogether_architecture` manually or `/hacktogether` to start a new run."
