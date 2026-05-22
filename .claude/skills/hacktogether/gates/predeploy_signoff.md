# Gate: predeploy_signoff

Trigger: after `phases/review.md` returns clean (or after force-pass on review block).
Halts: until user replies `deploy <target>` or `cancel`.
Outputs: `.hacktogether/runs/<run_id>/07-deploy/PREDEPLOY_SIGNOFF.md`; sets `deploy_target` in RUN_STATE.md.

## Pre-gate

Update RUN_STATE.md: `status: awaiting_hitl`, `current_phase: gate:predeploy_signoff`.

## Gather summary

1. Run `git log --oneline <first-commit-of-run>..HEAD | wc -l` → commit count.
2. Run `git diff --stat <first-commit-of-run>..HEAD | tail -1` → file change summary.
3. Read `05-test/TEST_REPORT.md`: extract pass/fail counts.
4. Read `06-review/HANDOFF.md`: extract review status (clean / N findings deferred / hotfix applied).
5. Read `.hacktogether/runs/<run_id>/SECRETS_USED.md`: list keys (NOT values).

## Surface to user

Print:

> ★ HITL — predeploy signoff
>
> **Diff:** <N> commits, <files-changed> files
> **Tests:** <pass>/<total> passing (<failed> failed)
> **Review:** <clean | hotfix applied | N non-blocking deferred>
> **Secrets used:** <list of key names>
>
> Choose deploy target:
> - `deploy dryrun` — generate artifacts only, no execution
> - `deploy local` — docker compose up locally
> - `deploy cloud:fly` — Fly.io
> - `deploy cloud:railway` — Railway
> - `deploy cloud:vercel` — Vercel
> - `deploy cloud:cloud-run` — Google Cloud Run
> - `cancel` — abort deploy phase

## Response handling

On `deploy <target>`:
1. Validate target against allowlist. If invalid, re-prompt.
2. Write `07-deploy/PREDEPLOY_SIGNOFF.md`:
   ```markdown
   ---
   gate: predeploy_signoff
   target: <target>
   approved_by: user
   approved_at: <iso8601>
   commits: <N>
   tests: <pass>/<total>
   ---
   ```
3. Update RUN_STATE.md: `deploy_target: <target>`, status: `in_progress`, gate column row #7 → `✓ signed off`.
4. Return control — orchestrator advances to `phases/deploy.md`.

On `cancel`:
1. Update RUN_STATE.md row #7 → `✗ cancelled`.
2. Surface: "Deploy cancelled. Run /hacktogether_predeploy_signoff again to retry, or /hacktogether_resume."
