import { describe, it, expect, vi } from 'vitest';
import { auditLogIntegrity } from '@harvoost/jobs';

// Item 1 (V1): audit-log-integrity HMAC recompute. The Postgres-side recompute
// is the canonical path (matches the trigger byte-for-byte); the unit test
// mocks the query and asserts:
//   - SET LOCAL is issued before any SELECT
//   - row_hash mismatches are logged with the tamper-detected metric tag
//   - no $transaction → falls back to linkage-only check (degraded mode)

function makeTxStub(rowsBatches: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let batchIdx = 0;
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      const batch = rowsBatches[batchIdx++] ?? [];
      return batch;
    }),
  };
  return { calls, tx };
}

function makePrismaWithTx(rowsBatches: Array<Array<Record<string, unknown>>>) {
  const { calls, tx } = makeTxStub(rowsBatches);
  return {
    calls,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('audit.daily_integrity_check — V1 HMAC recompute', () => {
  it('skips when auditHashSecret missing (operational warn, no crash)', async () => {
    const logger = makeLogger();
    const prisma = makePrismaWithTx([]);
    await auditLogIntegrity.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger } as any,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'audit.daily_integrity_check.no_secret',
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });

  it('issues SET LOCAL app.audit_hash_secret BEFORE any SELECT', async () => {
    const logger = makeLogger();
    const prisma = makePrismaWithTx([[]]); // single empty batch
    await auditLogIntegrity.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger, auditHashSecret: 'x'.repeat(32) } as any,
    );
    const sqls = prisma.calls.map((c) => c.sql);
    expect(sqls[0]).toMatch(/SET LOCAL app\.audit_hash_secret/);
  });

  it('logs hmac_mismatch when expected != actual', async () => {
    const logger = makeLogger();
    const goodRow = {
      id: 1n,
      row_hash: 'aaaa',
      prev_row_hash: null,
      expected: 'aaaa',
    };
    const tamperedRow = {
      id: 2n,
      row_hash: 'bbbb',
      prev_row_hash: 'aaaa',
      expected: 'cccc-recomputed',
    };
    const prisma = makePrismaWithTx([[goodRow, tamperedRow], []]);
    await auditLogIntegrity.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger, auditHashSecret: 'k'.repeat(32) } as any,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'audit.daily_integrity_check.hmac_mismatch',
      expect.objectContaining({
        id: 2,
        actual: 'bbbb',
        expected: 'cccc-recomputed',
        metric: 'audit_log_tamper_detected',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'audit.daily_integrity_check.tampered',
      expect.objectContaining({ hmacMismatches: 1, metric: 'audit_log_tamper_detected' }),
    );
  });

  it('reports OK when every row hash matches', async () => {
    const logger = makeLogger();
    const r1 = { id: 1n, row_hash: 'a', prev_row_hash: null, expected: 'a' };
    const r2 = { id: 2n, row_hash: 'b', prev_row_hash: 'a', expected: 'b' };
    const prisma = makePrismaWithTx([[r1, r2], []]);
    await auditLogIntegrity.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger, auditHashSecret: 'k'.repeat(32) } as any,
    );
    expect(logger.info).toHaveBeenCalledWith(
      'audit.daily_integrity_check.ok',
      expect.objectContaining({ rowsChecked: 2 }),
    );
  });

  it('escapes single quotes in the secret safely', async () => {
    const logger = makeLogger();
    const prisma = makePrismaWithTx([[]]);
    await auditLogIntegrity.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger, auditHashSecret: "'evil'" + 'x'.repeat(30) } as any,
    );
    const setLocal = prisma.calls[0]!;
    // Single-quotes in the secret get doubled per Postgres literal-escape rules.
    expect(setLocal.sql).toContain("''evil''");
    expect(setLocal.values).toHaveLength(0);
  });

  it('falls back to linkage-only when prisma stub lacks $transaction', async () => {
    const logger = makeLogger();
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => []),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    await auditLogIntegrity.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger, auditHashSecret: 'k'.repeat(32) } as any,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'audit.daily_integrity_check.no_transaction_api',
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });
});
