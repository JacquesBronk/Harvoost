import { describe, it, expect, vi } from 'vitest';
import { auditLogIntegrity } from '../audit-log-integrity';
import type { JobDeps } from '../../types';

interface AuditRow {
  id: string;
  row_hash: string;
  prev_row_hash: string | null;
  // Optional: when present, simulates an HMAC recompute result that DIFFERS from row_hash
  // (i.e., tampering). When omitted, the mock returns row_hash as `expected` (chain intact).
  expected?: string;
}

function makeDeps(rows: AuditRow[]) {
  const logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string; meta?: unknown }> = [];
  let returnedAll = false;
  const prismaStub = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('FROM audit_log') && sql.includes('id > $1')) {
        const lastId = Number(values[0]);
        const filtered = rows.filter((r) => Number(r.id) > lastId);
        if (filtered.length === 0) {
          returnedAll = true;
          return [];
        }
        // The impl's SELECT projects an `expected` column (Postgres-side HMAC recompute).
        // The mock substitutes row_hash by default so the chain verifies cleanly; rows
        // can override `expected` to simulate an HMAC mismatch.
        return filtered.slice(0, 500).map((r) => ({
          id: r.id,
          row_hash: r.row_hash,
          prev_row_hash: r.prev_row_hash,
          expected: r.expected ?? r.row_hash,
        }));
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 0),
  };
  // The impl runs the chain scan inside prisma.$transaction so SET LOCAL stays in scope.
  // The stub delegates to the same prisma surface so the inner code path is exercised.
  const prismaWithTx = Object.assign(prismaStub, {
    $transaction: async <T,>(fn: (tx: typeof prismaStub) => Promise<T>): Promise<T> => fn(prismaStub),
  });
  const deps: JobDeps = {
    // 32-char secret satisfies the no_secret guard so the HMAC path executes.
    auditHashSecret: 'test-audit-hmac-secret-32-chars!!',
    prisma: prismaWithTx as unknown as JobDeps['prisma'],
    llm: {
      provider: 'mock',
      model: 'mock-test',
      capabilities: () => ({ supportsTools: true, supportsStreaming: false }),
      generateText: async () => ({ text: '', usage: { promptTokens: 0, completionTokens: 0 } }),
      generateWithTools: async () => ({ text: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } }),
    },
    mailer: { send: async () => ({ messageId: 'test' }) },
    logger: {
      info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
    },
  };
  return { deps, logs, get returnedAll() { return returnedAll; } };
}

describe('audit.daily_integrity_check (REQUIREMENTS § Audit log)', () => {
  it('declares the documented cron (daily 04:00 UTC)', () => {
    expect(auditLogIntegrity.cron).toBe('0 4 * * *');
    expect(auditLogIntegrity.name).toBe('audit.daily_integrity_check');
  });

  it('logs ok with lastVerifiedId when the chain is intact', async () => {
    // Build a chain: row 1 has prev=null (or ""), row 2's prev_row_hash == row 1's row_hash.
    const rows: AuditRow[] = [
      { id: '1', row_hash: 'H1', prev_row_hash: '' },
      { id: '2', row_hash: 'H2', prev_row_hash: 'H1' },
      { id: '3', row_hash: 'H3', prev_row_hash: 'H2' },
    ];
    const { deps, logs } = makeDeps(rows);
    await auditLogIntegrity.handler(null, deps);
    const ok = logs.find((l) => l.msg === 'audit.daily_integrity_check.ok');
    expect(ok).toBeDefined();
    expect(ok!.meta).toMatchObject({ lastVerifiedId: 3 });
    const errs = logs.filter((l) => l.level === 'error');
    expect(errs).toHaveLength(0);
  });

  it('detects and logs a hash-chain mismatch (tampering)', async () => {
    // Tamper: row 2's prev_row_hash should be H1 but is instead H_TAMPERED.
    const rows: AuditRow[] = [
      { id: '1', row_hash: 'H1', prev_row_hash: '' },
      { id: '2', row_hash: 'H2', prev_row_hash: 'H_TAMPERED' },
    ];
    const { deps, logs } = makeDeps(rows);
    await auditLogIntegrity.handler(null, deps);
    // Impl emits `chain_break` (per-row, linkage failure) plus a summary `tampered` log at the end.
    const chainBreak = logs.find((l) => l.msg === 'audit.daily_integrity_check.chain_break');
    expect(chainBreak).toBeDefined();
    expect(chainBreak!.level).toBe('error');
    expect(chainBreak!.meta).toMatchObject({ mismatchAt: 2 });
    const summary = logs.find((l) => l.msg === 'audit.daily_integrity_check.tampered');
    expect(summary).toBeDefined();
    expect(summary!.level).toBe('error');
  });

  it('runs without errors on an empty audit_log', async () => {
    const { deps, logs } = makeDeps([]);
    await auditLogIntegrity.handler(null, deps);
    const errs = logs.filter((l) => l.level === 'error');
    expect(errs).toHaveLength(0);
  });
});
