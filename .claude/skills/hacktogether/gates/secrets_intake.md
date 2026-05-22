# Gate: secrets_intake

Trigger: after `phases/api_design.md` completes (and before `phases/build.md`).
Halts: until all required secrets are present in `.hacktogether/secrets.local.md`.
Outputs: `.hacktogether/runs/<run_id>/SECRETS_USED.md`.

## Pre-gate

Update RUN_STATE.md: `status: awaiting_hitl`, `current_phase: gate:secrets_intake`.

## Derive required secrets

1. Read `02-architecture/STACK.md` "Required secrets" section.
2. Also scan `03-api-design/openapi.yaml` for auth schemes that imply secrets (e.g., a bearer-auth scheme implies a `JWT_SECRET`).
3. Build a deduplicated list: `[DATABASE_URL, JWT_SECRET, APP_ENV, ...]` etc.

## Check current secrets file

1. If `.hacktogether/secrets.local.md` does NOT exist, create it with this content:

   ```markdown
   # HackTogether secrets manifest

   Format: one key per line, `KEY=value`. Lines starting with `#` are comments.
   Do NOT commit this file. It is gitignored.

   # Add your secrets below:

   ```

2. Parse the existing file: collect every line matching `^[A-Z_][A-Z0-9_]*=.+$` as a defined key.

## Write SECRETS_USED.md for this run

Write `.hacktogether/runs/<run_id>/SECRETS_USED.md`:

```markdown
# Secrets used by this run

## Required
- DATABASE_URL — for Postgres connection
- JWT_SECRET — for token signing
- APP_ENV — runtime mode

## Status
- DATABASE_URL: ✓ present in .hacktogether/secrets.local.md
- JWT_SECRET: ✗ MISSING
- APP_ENV: ✓ present
```

## Halt if missing

If any required key is missing:

Print to user:

> ★ HITL — secrets intake
>
> This run requires these secrets (defined in STACK.md and openapi.yaml):
> - DATABASE_URL ✓
> - JWT_SECRET ✗ MISSING
> - APP_ENV ✓
>
> Please add the missing keys to `.hacktogether/secrets.local.md` (one per line, `KEY=value`), then reply `continue`. Or reply `skip` to proceed with placeholders (build will use `__MISSING__` literals — useful only for dryrun deploy).

On `continue`: re-derive and re-check; loop until clean OR user says `skip`.
On `skip`: replace missing values with the literal `__MISSING__` in SECRETS_USED.md status; append Decision-log entry warning that secrets are placeholders.

## On success

1. Update RUN_STATE.md: gate column for the secrets row → `✓ filled` (or `⚠ skipped`).
2. Set `status: in_progress`.
3. Return control — orchestrator advances to `phases/build.md`.
