# Phase: api_design

Subagent: `api-designer`
Phase folder: `.hacktogether/runs/<run_id>/03-api-design/`
Inputs: `01-intake/REQUIREMENTS.md`, `02-architecture/ARCHITECTURE.md`, `02-architecture/STACK.md`
Outputs: `03-api-design/openapi.yaml`, `03-api-design/API_NOTES.md`, `03-api-design/HANDOFF.md`

## Pre-dispatch

Update RUN_STATE.md: row #3 (api_design) → `▶ running`.

If `02-architecture/STACK.md` indicates the system has NO HTTP API (e.g., CLI-only tool, library), skip this phase: write a stub `03-api-design/SKIPPED.md` explaining why, update RUN_STATE.md row #3 to `– skipped`, and return.

## Dispatch prompt

Task with subagent_type `api-designer`:

> You are the `api-designer` agent. The current run is `<run_id>`.
> Your assigned phase folder is `.hacktogether/runs/<run_id>/03-api-design/`.
> Required context:
> - `.hacktogether/runs/<run_id>/RUN_STATE.md`
> - `.hacktogether/runs/<run_id>/01-intake/REQUIREMENTS.md`
> - `.hacktogether/runs/<run_id>/02-architecture/ARCHITECTURE.md`
> - `.hacktogether/runs/<run_id>/02-architecture/STACK.md`
>
> Write:
> - `03-api-design/openapi.yaml` — OpenAPI 3.1 spec covering every endpoint implied by the user stories. Use snake_case for fields by default unless STACK.md says otherwise. Include success and error response schemas for every operation.
> - `03-api-design/API_NOTES.md` — one page covering: auth strategy, error envelope shape, pagination convention, versioning approach, rate-limit headers (if any). This is the contract downstream agents follow.
> - `03-api-design/HANDOFF.md`
>
> Exit after writing HANDOFF.md.

## Post-dispatch

1. Verify outputs exist.
2. Update RUN_STATE.md row #3 → `✓ done`, artifacts → `03-api-design/openapi.yaml`.
3. Return control — orchestrator advances to `gates/secrets_intake.md`.
