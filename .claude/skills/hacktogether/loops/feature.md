# Loop: feature

Entry point: `/hacktogether_feature <description>` OR `/hacktogether` mode router answers `feature`.

## Pre-loop

1. Identify the target run (same as incident loop step 1).
2. Allocate `FEAT-NNN` by listing `features/FEAT-*` in the target run folder.
3. Create `features/FEAT-NNN/` directory.
4. Write `features/FEAT-NNN/REQUEST.md` containing the verbatim user description.

## Step 1: Light intake (product-analyst)

Dispatch `product-analyst` with a TIGHTER scope than full intake:

> You are the `product-analyst` agent dispatched for a FEATURE addition to an existing system.
> Run `<run_id>`. Feature: `FEAT-NNN`.
> Phase folder: `.hacktogether/runs/<run_id>/features/FEAT-NNN/`.
> Feature request (verbatim):
> ```
> <user description>
> ```
> Existing system context: the original REQUIREMENTS.md, ARCHITECTURE.md, STACK.md, openapi.yaml from this run; current codebase.
>
> Produce `features/FEAT-NNN/FEATURE_PLAN.md` using the template at `.claude/skills/hacktogether/templates/FEATURE_PLAN.md.tpl`. Critical: the "Scope assessment" section must explicitly say whether structural changes are required and whether the API contract changes.
>
> Keep clarifications to ≤2 rounds (this is a smaller scope than full intake).
>
> Exit after writing FEATURE_PLAN.md + a HANDOFF.md.

## Step 2: Scope-driven re-entry

Read `features/FEAT-NNN/FEATURE_PLAN.md`:
- If "Structural change required: yes" → invoke `phases/architecture.md` (the architect agent reads FEATURE_PLAN.md and updates ARCHITECTURE.md / STACK.md in-place). Re-enter the `gates/approve_architecture.md` gate. After approval, continue.
- If "API change required: yes" → invoke `phases/api_design.md` (api-designer reads FEATURE_PLAN.md and updates openapi.yaml). No gate; api_design has no gate.
- Skip both if neither flag is set.

## Step 3: Build chain (scoped)

In order:
1. `phases/build.md` with `--scope features/FEAT-NNN/FEATURE_PLAN.md`. Only the agents whose modules are affected run.
2. `phases/test.md` — full suite (regressions matter).
3. `phases/review.md` — full review.
4. `gates/predeploy_signoff.md`.
5. `phases/deploy.md` — re-deploy. Same target as parent run by default.
6. `phases/docs.md` — update README and append to CHANGELOG.

## Post-loop

1. Append Decision-log entry: `<iso8601> FEAT-NNN deployed`.
2. Surface summary to user.
