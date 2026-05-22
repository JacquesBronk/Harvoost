# Phase: architecture

Subagent: `architect`
Phase folder: `.hacktogether/runs/<run_id>/02-architecture/`
Inputs: `01-intake/REQUIREMENTS.md`
Outputs: `02-architecture/ARCHITECTURE.md`, `02-architecture/STACK.md`, `02-architecture/HANDOFF.md`

## Pre-dispatch

Update RUN_STATE.md: row #2 (architecture) → `▶ running`.

## Dispatch prompt

Task with subagent_type `architect`:

> You are the `architect` agent. The current run is `<run_id>` (slug: `<slug>`).
> Your assigned phase folder is `.hacktogether/runs/<run_id>/02-architecture/`.
> Required context to load first:
> - `.hacktogether/runs/<run_id>/RUN_STATE.md`
> - `.hacktogether/runs/<run_id>/01-intake/REQUIREMENTS.md`
>
> Default stack policy: **FastAPI + Postgres + minimal React (Vite) + Docker compose**. Use this default unless the requirements explicitly contradict it (e.g., user asked for Go, mobile, ML, CLI-only). If you override, document the rationale in STACK.md and flag the override prominently for the HITL approval gate.
>
> Write:
> - `02-architecture/ARCHITECTURE.md` using `.claude/skills/hacktogether/templates/ARCHITECTURE.md.tpl`
> - `02-architecture/STACK.md` — a one-page stack manifest: language/runtime versions, framework choices, key libraries, and a section "Required secrets" listing env-var names the system will need at runtime (used by secrets_intake gate).
> - `02-architecture/HANDOFF.md`
>
> Include in ARCHITECTURE.md a "Concerns / flags for HITL approval" section listing anything the user should explicitly confirm before build (e.g., chosen tradeoffs, deferred features, scope boundaries).
>
> Exit after writing HANDOFF.md.

## Post-dispatch

1. Verify `ARCHITECTURE.md`, `STACK.md`, `HANDOFF.md` exist.
2. Update RUN_STATE.md row #2 → `✓ done`, artifacts → `02-architecture/ARCHITECTURE.md`.
3. Append Decision-log entry: `<iso8601> architect chose <stack summary>` (extract from STACK.md).
4. Return control to orchestrator — which advances to `gates/approve_architecture.md`.
