import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditService } from '../../src/common/audit/audit.service';
import type { Env } from '../../src/config/env';

// Unit test for AuditService — asserts:
//   - parameter mapping for the INSERT
//   - SET LOCAL app.audit_hash_secret is issued BEFORE the INSERT (V2 fix)
//   - errors propagate (no silent swallow — audit is load-bearing)

function makeEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    WORKER_MODE: false,
    DATABASE_URL: 'postgresql://localhost/test',
    SESSION_SECRET: 'a'.repeat(32),
    AUDIT_HASH_SECRET: 'b'.repeat(32),
    BOOTSTRAP_ADMIN_EMAIL: 'admin@harvoost.local',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/harvoost',
    OIDC_CLIENT_ID: 'harvoost-web',
    OIDC_REDIRECT_URI_WEB: 'http://localhost:3000/v1/auth/callback',
    OIDC_REDIRECT_URI_TRAY: 'harvoost://auth/callback',
    TEST_AUTH_BYPASS: false,
    LLM_PROVIDER: 'mock',
    LLM_MODEL_ID: 'mock-test',
    ACS_EMAIL_SENDER_ADDRESS: 'noreply@harvoost.local',
    BLOB_EXPORTS_CONTAINER: 'exports',
    WEB_ORIGIN: 'http://localhost:3000',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface TxCall {
  sql: string;
  values: unknown[];
}

function makePrismaStub(opts: { insertThrows?: boolean } = {}) {
  const txCalls: TxCall[] = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      txCalls.push({ sql, values });
      if (opts.insertThrows && sql.includes('INSERT INTO audit_log')) {
        throw new Error('audit_log table missing');
      }
      return 1;
    }),
  };
  return {
    txCalls,
    $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => {
      return fn(tx);
    }),
  };
}

describe('AuditService.record', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let svc: AuditService;

  beforeEach(() => {
    prisma = makePrismaStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = new AuditService(prisma as any, makeEnv());
  });

  it('issues SET LOCAL app.audit_hash_secret BEFORE the INSERT', async () => {
    await svc.record({
      actorId: '42',
      action: 'leave.approve',
      entityType: 'leave_request',
      entityId: '99',
    });
    expect(prisma.txCalls.length).toBeGreaterThanOrEqual(2);
    expect(prisma.txCalls[0]!.sql).toMatch(/SET LOCAL app\.audit_hash_secret/);
    expect(prisma.txCalls[1]!.sql).toMatch(/INSERT INTO audit_log/);
  });

  it('inlines the AUDIT_HASH_SECRET as a literal (SET LOCAL does not accept binds)', async () => {
    await svc.record({
      actorId: '1',
      action: 'user.role_grant',
      entityType: 'user',
      entityId: '2',
    });
    const setLocal = prisma.txCalls[0]!;
    // The secret is inlined as a single-quoted string literal.
    expect(setLocal.sql).toContain(`'${'b'.repeat(32)}'`);
    expect(setLocal.values).toHaveLength(0);
  });

  it('inserts a row with positional bindings for actor_id, action, entity_type, entity_id', async () => {
    await svc.record({
      actorId: '42',
      action: 'leave.approve',
      entityType: 'leave_request',
      entityId: '99',
      before: { status: 'pending' },
      after: { status: 'approved' },
    });
    const insertCall = prisma.txCalls.find((c) => c.sql.includes('INSERT INTO audit_log'))!;
    expect(insertCall).toBeDefined();
    expect(insertCall.values[0]).toBe('42');
    expect(insertCall.values[1]).toBe('leave.approve');
    expect(insertCall.values[2]).toBe('leave_request');
    expect(insertCall.values[3]).toBe('99');
    expect(insertCall.values[4]).toBe(JSON.stringify({ status: 'pending' }));
    expect(insertCall.values[5]).toBe(JSON.stringify({ status: 'approved' }));
  });

  it('serialises optional fields to null when omitted', async () => {
    await svc.record({
      actorId: '1',
      action: 'user.role_revoke',
      entityType: 'user',
      entityId: '2',
    });
    const insertCall = prisma.txCalls.find((c) => c.sql.includes('INSERT INTO audit_log'))!;
    expect(insertCall.values[4]).toBeNull(); // before
    expect(insertCall.values[5]).toBeNull(); // after (after+metadata both undefined → null)
    expect(insertCall.values[6]).toBeNull(); // reason
  });

  it('folds metadata into the after column (no separate column)', async () => {
    await svc.record({
      actorId: '1',
      action: 'leave.cancel',
      entityType: 'leave_request',
      entityId: '9',
      after: { status: 'cancelled' },
      metadata: { rows_affected: 1 },
    });
    const insertCall = prisma.txCalls.find((c) => c.sql.includes('INSERT INTO audit_log'))!;
    const after = JSON.parse(insertCall.values[5] as string);
    expect(after).toMatchObject({ status: 'cancelled', _metadata: { rows_affected: 1 } });
  });

  it('THROWS when the DB write fails (V2 fix — no silent swallow)', async () => {
    const failingPrisma = makePrismaStub({ insertThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failing = new AuditService(failingPrisma as any, makeEnv());
    await expect(
      failing.record({ actorId: '1', action: 'x', entityType: 'y', entityId: 'z' }),
    ).rejects.toThrow(/audit_log table missing/);
  });

  it('escapes single quotes in AUDIT_HASH_SECRET safely', async () => {
    const env = makeEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).AUDIT_HASH_SECRET = "x".repeat(31) + "'oops";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc2 = new AuditService(prisma as any, env);
    await svc2.record({ actorId: '1', action: 'x', entityType: 'y', entityId: 'z' });
    const setLocal = prisma.txCalls[0]!;
    // Single quote in the secret is doubled.
    expect(setLocal.sql).toContain("''oops");
    // Ensure no unescaped single quote remains adjacent to outer quote.
    expect(setLocal.sql).not.toMatch(/'[^']'oops/);
  });
});
