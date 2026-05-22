# Phase: docs

Subagents: `docs-writer`, then `changelog-writer` (sequential — changelog reads what docs-writer says about scope).
Phase folder: `.hacktogether/runs/<run_id>/08-docs/`
Inputs: codebase, REQUIREMENTS.md, DEPLOY_PLAN.md, git log
Outputs: `README.md` (project root), `CHANGELOG.md` (project root), `08-docs/HANDOFF.md`

## Pre-dispatch

Update RUN_STATE.md row #8 → `▶ running`.

## Dispatch prompt — docs-writer

> You are the `docs-writer` agent. Run `<run_id>`.
> Phase folder: `.hacktogether/runs/<run_id>/08-docs/`.
> Required context: REQUIREMENTS.md, ARCHITECTURE.md, STACK.md, DEPLOY_PLAN.md, codebase.
>
> Write `README.md` at the project root: project overview (1 paragraph from REQUIREMENTS), prerequisites (from STACK.md), setup steps (from DEPLOY_PLAN.md), running locally, running tests, project layout.
>
> Verify every command in the README actually works (test the setup steps by running them, except cloud-deploy steps).
>
> Append a partial HANDOFF.md noting files touched. The changelog-writer will overwrite it next.
>
> Exit.

## Dispatch prompt — changelog-writer

> You are the `changelog-writer` agent. Run `<run_id>`.
> Phase folder: `.hacktogether/runs/<run_id>/08-docs/`.
> Required context: git log since the start of this run, REQUIREMENTS.md, the new README.md.
>
> Write `CHANGELOG.md` at the project root. For a new system, this is the v0.1.0 initial release entry: summary, key features (mapped to user stories), known limitations.
>
> Overwrite `08-docs/HANDOFF.md` aggregating both docs work items.
>
> Exit.

## Post-dispatch

1. Verify README.md, CHANGELOG.md, and HANDOFF.md exist.
2. Update RUN_STATE.md row #8 → `✓ done`, artifacts → `README.md, CHANGELOG.md`.
3. Update RUN_STATE.md top-level: `status: complete`.
4. Print summary to user: phase counts, time taken, deploy URL (if local/cloud), artifact root path.
