# Loop: incident

Entry point: `/hacktogether_incident <description>` OR `/hacktogether` mode router answers `bug`.

## Pre-loop

1. Identify the target run: if user provided run-id, use it. Else use the most recent completed run (`ls -1t .hacktogether/runs/ | head -1`).
2. Read that run's RUN_STATE.md to confirm it's `status: complete`. If not complete, warn the user and ask whether to proceed anyway.
3. Allocate `INC-NNN` by listing `incidents/INC-*` in the target run folder and incrementing.
4. Create `incidents/INC-NNN/` directory.

## Step 1: Triage (incident-responder)

Dispatch `incident-responder`:

> You are the `incident-responder` agent. Run `<run_id>`. Incident: `INC-NNN`.
> Phase folder: `.hacktogether/runs/<run_id>/incidents/INC-NNN/`.
> Reported description (verbatim from user):
> ```
> <user's description text>
> ```
>
> Context: RUN_STATE.md, DEPLOY_PLAN.md, DEPLOY_LOG.md, full codebase, recent git log.
>
> Triage: severity, scope, reproduction steps, rollback recommendation. Write `incidents/INC-NNN/REPORT.md` using the template at `.claude/skills/hacktogether/templates/INCIDENT_REPORT.md.tpl`.
>
> Exit.

## Step 2: Rollback branch

Read `incidents/INC-NNN/REPORT.md`. If `Rollback recommended: yes`:
1. Surface to user: "Incident-responder recommends rollback. Plan: revert deploy artifact to <prior-tag>. Proceed? (`rollback` / `proceed-anyway` / `cancel`)"
2. On `rollback`:
   a. Read RUN_STATE.md `deploy_target`. Re-dispatch `devops` with the previous deploy artifact (git tag or commit) — use the same target backend.
   b. Append Decision-log entry. Mark INC-NNN status `rolled-back` in REPORT.md.
3. On `proceed-anyway`: continue to step 3 below.
4. On `cancel`: halt.

If `Rollback recommended: no`: continue to step 3 below.

## Step 3: Debug (debugger)

Dispatch `debugger`:

> You are the `debugger` agent. Incident: `INC-NNN`.
> Phase folder: `.hacktogether/runs/<run_id>/incidents/INC-NNN/`.
> Context: REPORT.md, full codebase, recent test report.
>
> Reproduce the failure. Form a hypothesis. Narrow until you find the root cause. Write `incidents/INC-NNN/ROOT_CAUSE.md` (1-page: hypothesis history + final cause + evidence) and `incidents/INC-NNN/HOTFIX_PLAN.md` (concrete files to change, tests to add, suggested implementer agent).
>
> Do NOT implement the fix. The build phase does that.
>
> Exit.

## Step 4: Hotfix chain (re-enter the DAG, scoped)

In order:
1. `phases/build.md` invoked with `--scope incidents/INC-NNN/HOTFIX_PLAN.md`. Only the agents named in the plan run.
2. `phases/test.md` — full suite (regressions matter).
3. `phases/review.md` — full review.
4. `gates/predeploy_signoff.md` — always required for hotfixes.
5. `phases/deploy.md` — re-deploy. By default use the same target as the parent run (read from RUN_STATE.md). User can change at the gate.

The hotfix chain intentionally does NOT auto-run `phases/docs.md`. Hotfixes are often small or invisible, and the user may want to bundle multiple hotfixes into one CHANGELOG entry. If the hotfix has user-visible behavior changes, manually invoke `/hacktogether_docs` after the loop completes.

## Post-loop

1. Append Decision-log entry: `<iso8601> INC-NNN closed`.
2. Update INC-NNN/REPORT.md status to `closed`.
3. Surface to user: incident summary + new deploy URL (if changed).
