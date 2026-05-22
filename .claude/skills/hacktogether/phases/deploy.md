# Phase: deploy

Subagent: `devops`
Phase folder: `.hacktogether/runs/<run_id>/07-deploy/`
Inputs: full codebase, STACK.md, SECRETS_USED.md
Outputs: `07-deploy/DEPLOY_PLAN.md`, `07-deploy/DEPLOY_LOG.md`, `07-deploy/HANDOFF.md`, plus deploy artifacts in project root.

## Pre-dispatch

The deploy target was set by `gates/predeploy_signoff.md` and is recorded in RUN_STATE.md `deploy_target`. Read it.

Valid values: `dryrun`, `local`, `cloud:fly`, `cloud:railway`, `cloud:vercel`, `cloud:cloud-run`.

Update RUN_STATE.md row #7 → `▶ running`.

## Dispatch prompt — devops

> You are the `devops` agent. Run `<run_id>`. Deploy target: `<target>`.
> Phase folder: `.hacktogether/runs/<run_id>/07-deploy/`.
> Required context:
> - RUN_STATE.md, STACK.md, ARCHITECTURE.md
> - SECRETS_USED.md (which secret keys the system needs)
> - `.hacktogether/secrets.local.md` (the actual secret values — handle with care; never log)
> - codebase under `src/`, `tests/`, `migrations/`, etc.
>
> First, write `07-deploy/DEPLOY_PLAN.md` describing exactly what you will do: artifacts to create, commands to run, expected outcomes.
>
> Then, based on target:
> - `dryrun`: Create Dockerfile, docker-compose.yml, CI yaml (.github/workflows/ci.yml), and a runbook in DEPLOY_PLAN.md. Do NOT execute anything. Write a final `07-deploy/HANDOFF.md` with status: success.
> - `local`: Do all of the above PLUS run `docker compose up -d --build`, tail logs for 30 seconds into `07-deploy/DEPLOY_LOG.md`, verify a healthz or root endpoint returns 200 with `curl`. On success, leave the containers running and record the local URL in HANDOFF.md.
> - `cloud:<provider>`: Generate provider-specific config (fly.toml / railway.json / vercel.json / cloudbuild.yaml), require the provider CLI to be installed, run the deploy command, capture deploy URL, write logs to `07-deploy/DEPLOY_LOG.md`. If the CLI isn't installed, write artifacts + manual runbook and status: partial.
>
> Exit after writing HANDOFF.md.

## Post-dispatch

1. Verify outputs.
2. Update RUN_STATE.md row #7 → `✓ done` (or `⚠ partial` if status=partial), artifacts → `07-deploy/DEPLOY_PLAN.md`.
3. Return control — orchestrator advances to `phases/docs.md`.
