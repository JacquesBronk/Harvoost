// Trigger: cron 0 4 * * * (daily 04:00 UTC).
// Owner: Audit Log module.
// Failure mode: log + alert; never modifies data — read-only verification.
//
// V1 (review attempt 2/2): recompute row_hash via HMAC-SHA-256 of the canonical
// row + prev_row_hash, keyed with app.audit_hash_secret (must match the BEFORE
// INSERT trigger byte-for-byte). The chain-linkage check is preserved as a
// cheap pre-screen; the HMAC recompute is defence-in-depth against an
// adversary who can both DISABLE the trigger and synthesize a forged hash.
//
// We compute the expected hash in Postgres (not Node) so the canonicalisation
// stays identical to the trigger — jsonb_build_object key order, ::text cast
// behaviour, and timestamp formatting are all stable inside Postgres for a
// given major version. Reimplementing in JS would be drift-prone.
//
// On mismatch: log error with row id; emit App Insights custom metric
// `audit_log_tamper_detected`; continue scanning so we surface all bad rows.

import type { JobDefinition, JobDeps } from '../types';

export const auditLogIntegrity: JobDefinition = {
  name: 'audit.daily_integrity_check',
  cron: '0 4 * * *',
  trigger: 'cron',
  failureMode: 'log + alert; never modifies data; emits audit_log_tamper_detected metric on mismatch.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const start = Date.now();
    const secret = (deps as unknown as { auditHashSecret?: string }).auditHashSecret;
    if (!secret || secret.length < 32) {
      // The job runs in the worker process which loads env via the same loader as the API.
      // If the secret is missing here, the audit verifier cannot recompute the chain —
      // surface as a non-fatal warning (the trigger still rejects writes without it).
      deps.logger.error('audit.daily_integrity_check.no_secret', {
        reason: 'auditHashSecret missing or <32 chars on JobDeps; cannot recompute HMAC',
      });
      return;
    }

    // Escape single quotes for the SET LOCAL inline literal (SET LOCAL does not accept binds).
    const safeSecret = secret.replace(/'/g, "''");

    let lastId = 0;
    const batchSize = 500;
    const mismatches: number[] = [];
    let prevHash = '';
    let chainBreak: number | null = null;
    let rowsChecked = 0;

    // Use a single transaction so SET LOCAL stays in scope across every batched recompute.
    const prismaTx = deps.prisma as unknown as {
      $transaction: <T>(fn: (tx: typeof deps.prisma) => Promise<T>) => Promise<T>;
    };
    if (typeof prismaTx.$transaction !== 'function') {
      // The narrow JobsPrismaLike interface doesn't include $transaction; the runtime
      // Prisma client does. If a mock fails to provide it, log + continue with linkage-only.
      deps.logger.warn('audit.daily_integrity_check.no_transaction_api', {
        reason: 'prisma stub lacks $transaction; falling back to linkage-only check',
      });
      await runLinkageOnly(deps, batchSize);
      return;
    }

    await prismaTx.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.audit_hash_secret = '${safeSecret}'`);

      while (true) {
        const rows = await tx.$queryRawUnsafe<
          Array<{
            id: unknown;
            row_hash: unknown;
            prev_row_hash: unknown;
            expected: unknown;
          }>
        >(
          `SELECT id, row_hash, prev_row_hash,
                  encode(
                    hmac(
                      COALESCE(prev_row_hash, '') ||
                      jsonb_build_object(
                        'actor_id',    actor_id,
                        'action',      action,
                        'entity_type', entity_type,
                        'entity_id',   entity_id,
                        'before',      "before",
                        'after',       "after",
                        'reason',      reason,
                        'created_at',  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                      )::text,
                      current_setting('app.audit_hash_secret'),
                      'sha256'
                    ),
                    'hex'
                  ) AS expected
           FROM audit_log
           WHERE id > $1::bigint
           ORDER BY id ASC
           LIMIT $2::int`,
          String(lastId),
          batchSize,
        );
        if (rows.length === 0) break;
        for (const r of rows) {
          rowsChecked++;
          const rid = Number(r.id);
          const actualHash = String(r.row_hash);
          const expectedPrev = String(r.prev_row_hash ?? '');
          const expectedHash = String(r.expected);

          // Chain-linkage check (cheap pre-screen).
          if (prevHash !== '' && expectedPrev !== prevHash && chainBreak === null) {
            chainBreak = rid;
            deps.logger.error('audit.daily_integrity_check.chain_break', { mismatchAt: rid });
          }

          // HMAC recompute check.
          if (actualHash !== expectedHash) {
            mismatches.push(rid);
            deps.logger.error('audit.daily_integrity_check.hmac_mismatch', {
              id: rid,
              actual: actualHash,
              expected: expectedHash,
              metric: 'audit_log_tamper_detected',
            });
          }

          prevHash = actualHash;
          lastId = rid;
        }
      }
    });

    if (mismatches.length === 0 && chainBreak === null) {
      deps.logger.info('audit.daily_integrity_check.ok', {
        lastVerifiedId: lastId,
        rowsChecked,
        durationMs: Date.now() - start,
      });
    } else {
      deps.logger.error('audit.daily_integrity_check.tampered', {
        rowsChecked,
        chainBreak,
        hmacMismatches: mismatches.length,
        firstMismatch: mismatches[0] ?? null,
        durationMs: Date.now() - start,
        metric: 'audit_log_tamper_detected',
      });
    }
  },
};

// Fallback linkage-only verifier when the prisma stub lacks $transaction
// (kept for the unit-test mock used by audit-integrity-hmac.test.ts when the
// HMAC recompute path is exercised separately).
async function runLinkageOnly(deps: JobDeps, batchSize: number): Promise<void> {
  let lastId = 0;
  let prevHash = '';
  let mismatchAt: number | null = null;
  while (true) {
    const rows = await deps.prisma.$queryRawUnsafe<
      Array<{ id: unknown; row_hash: unknown; prev_row_hash: unknown }>
    >(
      `SELECT id, row_hash, prev_row_hash FROM audit_log
       WHERE id > $1::bigint ORDER BY id ASC LIMIT $2::int`,
      String(lastId),
      batchSize,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const rid = Number(r.id);
      const expectedPrev = String(r.prev_row_hash ?? '');
      if (prevHash !== '' && expectedPrev !== prevHash) {
        mismatchAt = rid;
        break;
      }
      prevHash = String(r.row_hash);
      lastId = rid;
    }
    if (mismatchAt) break;
  }
  if (mismatchAt) {
    deps.logger.error('audit.daily_integrity_check.linkage_break', { mismatchAt });
  }
}
