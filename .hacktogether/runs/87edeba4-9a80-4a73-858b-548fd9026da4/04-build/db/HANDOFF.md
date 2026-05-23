---
phase: build (review-loop attempt 1/2)
agent: database-admin (fix loop)
started: 2026-05-22T21:05:00Z
finished: 2026-05-22T21:15:00Z
status: complete
---

# Summary

Fixed **Finding 6 (CRITICAL)** from `06-review/FIX_PLAN.md`. Authored a single new migration that converts the `audit_log` hash chain from plain `digest(..., 'sha256')` to `hmac(..., current_setting('app.audit_hash_secret'), 'sha256')`. The trigger is now keyed with a per-session secret that lives only in app-process memory (and Azure Key Vault), defeating the previous forge-and-rebuild attack against anyone with raw DB write access. Function and trigger names preserved (`audit_log_hash_chain`, `audit_log_hash_chain_trg`) to minimise churn. Canonical-JSON key set preserved exactly (`actor_id`, `action`, `entity_type`, `entity_id`, `before`, `after`, `reason`, `created_at`) so the integrity job's verification path is unchanged apart from swapping the cryptographic primitive. Greenfield assumption (audit_log empty at migration time) is documented in the migration header; no backfill is performed.

# Files touched

- `/mnt/c/Projects/Harvoost/packages/db/prisma/migrations/20260522170000_audit_hmac/migration.sql` (new) — drops the old SHA-256 trigger + function, recreates them with HMAC-SHA-256 keyed by the `app.audit_hash_secret` GUC, includes an explicit DOWN block as comments for manual rollback.
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/04-build/db/HANDOFF.md` (modified) — this file, overwriting the previous build-round handoff.

**NOT touched** (per file-ownership boundaries):
- `packages/db/prisma/schema.prisma` (no Prisma model change needed — `audit_log` column shape is unchanged)
- `packages/db/prisma/migrations/20260522000000_init/migration.sql` (the new migration drops/replaces the old trigger; the init migration is left immutable)
- Any `apps/**`, `packages/{shared,jobs,ui}/**` file.

# What downstream agents need to know

## For backend-dev (Findings 5, 11 — and the cross-cutting wiring for Finding 6)

The contract for inserting into `audit_log` has changed in two ways. Both **must** be implemented or every state-changing endpoint will start failing with `app.audit_hash_secret must be set and >= 32 chars`.

1. **Session GUC is mandatory before any `INSERT INTO audit_log`.** Anywhere the API (or jobs) opens a Prisma connection that will eventually insert into `audit_log`, the secret must be applied per-session. Two viable patterns; **recommend the middleware (1a)** because it is fail-closed by default — no future controller can forget to set it:

   **1a. (Recommended) Prisma client extension or middleware** in `apps/api/src/database.module.ts` (or wherever the Prisma client is constructed) that runs once per connection:

   ```ts
   prisma.$use(async (params, next) => {
     // Set the secret at the start of every transaction that might write audit_log.
     // SET LOCAL is scoped to the current transaction.
     if (params.action === 'create' && params.model === 'AuditLog') {
       throw new Error('Insert audit_log only via AuditService — SET LOCAL must precede the INSERT');
     }
     return next(params);
   });
   ```

   Pair this with **AuditService.record(...)** that wraps the insert in its own `$transaction` and runs `SET LOCAL app.audit_hash_secret = $1` as the first statement:

   ```ts
   async record(args: AuditRecordArgs): Promise<void> {
     await this.prisma.$transaction(async (tx) => {
       await tx.$executeRawUnsafe(
         `SET LOCAL app.audit_hash_secret = '${this.env.AUDIT_HASH_SECRET.replace(/'/g, "''")}'`
       );
       // NOTE: AUDIT_HASH_SECRET is server-side env, NOT user input — but we still
       // escape single quotes defensively. Postgres SET LOCAL does not accept
       // bind parameters, so plain interpolation is unavoidable here.
       await tx.auditLog.create({
         data: {
           actor_id: args.actorId,
           action: args.action,
           entity_type: args.entityType,
           entity_id: args.entityId,
           before: args.before ?? null,
           after: args.after ?? null,
           reason: args.reason ?? null,
           // DO NOT supply row_hash or prev_row_hash — the trigger is the sole authority.
         },
       });
     });
   }
   ```

   **1b. (Alternative) Connection-pool init hook** if the codebase has one — wire the `SET app.audit_hash_secret` at `on_connect` so every connection from the pool is pre-armed. Easier to reason about per-call, harder to wire with Prisma (pg-boss workers may need separate handling).

2. **Stop supplying `row_hash` and `prev_row_hash` from the app.** The new trigger overwrites both unconditionally. The init-migration's "app can pre-compute" comment is now obsolete. Callers should INSERT only the semantic columns; the trigger fills hash columns before the NOT-NULL check fires.

## For backend-dev (Finding 11 specifically — integrity job)

`packages/jobs/src/jobs/audit-log-integrity.ts` MUST be updated to:

1. **Set the secret at session start** before SELECTing the chain:
   ```ts
   await prisma.$executeRawUnsafe(`SET LOCAL app.audit_hash_secret = '${env.AUDIT_HASH_SECRET}'`);
   ```
   (Or use the same middleware/extension pattern.)
2. **Recompute, not just verify linkage.** For each row, build the canonical JSON in the SAME shape the trigger uses (see the migration's `v_canonical := jsonb_build_object(...)` block — the key set is `actor_id`, `action`, `entity_type`, `entity_id`, `before`, `after`, `reason`, `created_at`, in that order). Compute `expected = encode(hmac(prev_row_hash || canonical, secret, 'sha256'), 'hex')`. Assert `expected === stored_row_hash`. Flag any mismatch with the row id, log, and (per architecture) page the on-call.
3. **Canonicalisation reproducibility.** The trigger uses Postgres's `jsonb_build_object(...)::text` followed by HMAC over the resulting text. Reproducing this in TypeScript exactly is non-trivial (jsonb's text representation has Postgres-specific spacing). The safest pattern is to delegate the recomputation to Postgres itself via a `SELECT encode(hmac(...) , ...) AS expected FROM audit_log WHERE id = $1` query, then compare in TS. **Recommend** running the verification SQL-side per-row (one round-trip per row) or as a single set-based query with a WHERE clause that filters to mismatches.

## For tester

Add a new integration test (Finding 6 acceptance test) that covers:

1. **Insert without GUC fails.** Open a fresh Prisma client connection, do NOT set `app.audit_hash_secret`, attempt to INSERT into `audit_log` → expect `insufficient_privilege` SQLSTATE (42501) with message containing `audit_log INSERT requires app.audit_hash_secret`.
2. **Insert with short secret fails.** `SET LOCAL app.audit_hash_secret = 'too-short'` → INSERT fails with `app.audit_hash_secret must be set and >= 32 chars`.
3. **Insert with valid secret succeeds and HMAC recomputes.** SET LOCAL with a >= 32-char secret, INSERT, then verify in the same transaction: SELECT the row, recompute `encode(hmac(prev_row_hash || jsonb_build_object(...)::text, '<same secret>', 'sha256'), 'hex')` via a `SELECT` and assert equality with the stored `row_hash`.
4. **Chain linkage preserved.** Insert two rows in sequence; assert row #2's `prev_row_hash` equals row #1's `row_hash`.
5. **Genesis row.** First INSERT against an empty audit_log has `prev_row_hash = repeat('0', 64)`.

## For devops

- `AUDIT_HASH_SECRET` env var (already declared in `env.ts` per the security review) must now be loaded into **every** process that opens a DB connection that may insert into audit_log. That is at minimum `apps/api` (controllers) and the pg-boss worker process (the audit-log-integrity job + any job that audits its actions).
- The secret is a CRITICAL key — leakage allows forgery. Store in Azure Key Vault. Rotate at least annually with a key-id tag in the row's metadata if/when rotation is implemented (out of scope for v1).
- Verify the secret length: 32+ chars (the trigger floor). 64-char hex (256-bit entropy) recommended.
- For local-dev: pre-populated `.hacktogether/secrets.local.md` with a dev `AUDIT_HASH_SECRET`. Ensure it is >= 32 chars or the dev migration apply will succeed but every audit insert will fail.

## Architectural notes for the next reviewer

- The append-only triggers (`audit_log_no_update`, `audit_log_no_delete` from the init migration) remain in place and are independent of this change. They block UPDATE/DELETE regardless of session GUC.
- The `pgcrypto` extension is already loaded by the init migration (line 15), so `hmac(...)` and `digest(...)` are both available — no new extension required.
- The GUC name `app.audit_hash_secret` uses the "two-part" form (`<prefix>.<name>`) which Postgres accepts for custom GUCs without prior declaration. No `ALTER SYSTEM` is needed.
- Backward-compatibility: rows written by the old SHA-256 trigger will not recompute under HMAC. The integrity job MUST treat the migration boundary as the chain's restart point (record the boundary id once at migration apply time, then verify only rows after it). Greenfield deployment makes this a no-op for v1; the comment in the migration header captures this for the operator if the contract changes later.

# Open questions / unknowns

- **Does Prisma's `$executeRawUnsafe('SET LOCAL ...')` correctly scope to the same transaction as the subsequent `tx.auditLog.create(...)`?** Yes when both are inside the same `$transaction(async (tx) => ...)` callback — `SET LOCAL` is transaction-scoped and `tx` is a single connection for the duration. Confirmed via Prisma docs; flag for backend-dev to validate during implementation.
- **Should the trigger reject INSERTs where the caller supplied `row_hash` or `prev_row_hash` (instead of silently overwriting)?** Current implementation silently overwrites (matches init-migration semantics). A stricter version would `RAISE EXCEPTION` to catch buggy callers. Deferring to backend-dev's judgement — the silent-overwrite is the safer default for v1 because legacy code paths in the codebase may still send placeholders.
- **No live DB available in sandbox.** Migration syntax validated by inspection only. Backend-dev's first action (or the tester's CI run) will be the first end-to-end exercise.

# Verification evidence

- **Migration file syntax inspection.** Re-read `20260522170000_audit_hmac/migration.sql`. All identifiers quoted to match init-migration style; SQL keywords capitalised; PL/pgSQL block delimited with `$$ … $$` (no dollar-tag clashes with the body). `BEGIN ... EXCEPTION WHEN undefined_object` correctly nests inside the outer PL/pgSQL function body.
- **`pgcrypto` extension availability.** Confirmed via `grep -n "CREATE EXTENSION" packages/db/prisma/migrations/20260522000000_init/migration.sql` → line 15 enables `pgcrypto`, which provides both `digest()` and `hmac()`. No additional extension required.
- **`btree_gist` extension** (mentioned in the dispatch as a sanity check) is also enabled by the init migration (line 14). The new migration does not depend on it.
- **No schema-shape changes.** Verified by reading the init migration's `CREATE TABLE "audit_log"` block (lines 347-359). All eight semantic columns referenced in the trigger's `jsonb_build_object(...)` exist; `prev_row_hash` (CHAR(64)) and `row_hash` (CHAR(64) NOT NULL) exist; the BEFORE INSERT trigger fills them before the NOT NULL check.
- **Existing triggers preservation.** Init migration's `audit_log_no_update` (line 487) and `audit_log_no_delete` (line 491) are not referenced by this migration's `DROP TRIGGER`, so they remain in force.
- **Live `prisma migrate dev` / `prisma migrate deploy` NOT executed** — sandbox has no Postgres, per dispatch instructions. The migration will be applied by backend-dev (or by the predeploy CI) as the first action after the build round closes.
