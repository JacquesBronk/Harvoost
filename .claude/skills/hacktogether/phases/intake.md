# Phase: intake

Subagent: `product-analyst`
Phase folder: `.hacktogether/runs/<run_id>/01-intake/`
Inputs: `PROMPT.md`
Outputs: `01-intake/REQUIREMENTS.md`, `01-intake/HANDOFF.md`, `01-intake/interview.transcript.md` (optional, recommended)

## Pre-dispatch

Update RUN_STATE.md: row #1 (intake) → `▶ running`.

## Dispatch prompt

Issue a single Task call with subagent_type `product-analyst` and this prompt:

> You are the `product-analyst` agent. The current run is `<run_id>` (slug: `<slug>`, mode: new_system).
> Your assigned phase folder is `.hacktogether/runs/<run_id>/01-intake/`.
> Required context to load first:
> - `.hacktogether/runs/<run_id>/RUN_STATE.md`
> - `.hacktogether/runs/<run_id>/PROMPT.md`
>
> If the prompt is ambiguous, you may surface clarifying questions BACK to the orchestrator (via your reply). The orchestrator will relay to the user and re-invoke you with the answers appended to PROMPT.md.
> If clarifications are exhausted or the prompt is clear, write:
> - `01-intake/REQUIREMENTS.md` using the template at `.claude/skills/hacktogether/templates/REQUIREMENTS.md.tpl`
> - `01-intake/interview.transcript.md` capturing any Q&A (optional)
> - `01-intake/HANDOFF.md` using `.claude/skills/hacktogether/templates/HANDOFF.md.tpl`
>
> Do not write outside `01-intake/`. Do not contact peers. Exit after writing HANDOFF.md.

## Clarification loop (HITL)

If the agent returns with clarifying questions instead of a HANDOFF.md:
1. Surface the questions to the user verbatim.
2. Append the user's responses to `.hacktogether/runs/<run_id>/PROMPT.md` under an `## Additional clarifications` heading.
3. Re-dispatch the product-analyst with the same prompt (it'll re-read PROMPT.md).
4. Cap: 3 rounds of clarifications. After round 3, instruct the agent to proceed and mark assumptions `[ASSUMED:]`.

## Post-dispatch

1. Verify `01-intake/REQUIREMENTS.md` and `01-intake/HANDOFF.md` exist.
2. Update RUN_STATE.md row #1 → `✓ done`, artifacts → `01-intake/REQUIREMENTS.md`.
3. Append any HANDOFF "What downstream agents need to know" notes to Decision log.
4. Return control to the orchestrator (which advances to phases/architecture.md).
