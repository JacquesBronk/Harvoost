import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportJobsService } from '../../src/exports/export-jobs.service';
import type { Env } from '../../src/config/env';

// Unit tests for ExportJobsService — the persistence + upload glue for
// async XLSX exports.

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    WORKER_MODE: false,
    DATABASE_URL: 'postgresql://localhost/test',
    SESSION_SECRET: 'a'.repeat(32),
    AUDIT_HASH_SECRET: 'b'.repeat(32),
    BOOTSTRAP_ADMIN_EMAIL: 'boss@harvoost.local',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    OIDC_ISSUER_URL: 'http://kc/realms/harvoost',
    OIDC_CLIENT_ID: 'harvoost-web',
    OIDC_REDIRECT_URI_WEB: 'http://localhost:3000/v1/auth/callback',
    OIDC_REDIRECT_URI_TRAY: 'harvoost://auth/callback',
    TEST_AUTH_BYPASS: false,
    LLM_PROVIDER: 'mock',
    LLM_MODEL_ID: 'mock-test',
    ACS_EMAIL_SENDER_ADDRESS: 'noreply@harvoost.local',
    BLOB_EXPORTS_CONTAINER: 'exports',
    WEB_ORIGIN: 'http://localhost:3000',
    BLOB_STORAGE_CONNECTION_STRING: undefined,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makePrismaStub(opts: { existingJob?: Record<string, unknown> | null } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (/INSERT INTO export_jobs/.test(sql)) {
        return [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }];
      }
      if (/SELECT id, actor_user_id, status/.test(sql)) {
        return opts.existingJob ? [opts.existingJob] : [];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return 1;
    }),
  };
}

describe('ExportJobsService.create', () => {
  it('inserts a queued row with actor_user_id + filter JSONB and returns the new id', async () => {
    const prisma = makePrismaStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new ExportJobsService(prisma as any, makeEnv());
    const { jobId } = await svc.create('42', { date_from: '2026-05-01', date_to: '2026-05-31' });
    expect(jobId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const insert = prisma.calls.find((c) => /INSERT INTO export_jobs/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.values[0]).toBe('42');
    expect(JSON.parse(insert!.values[1] as string)).toEqual({
      date_from: '2026-05-01',
      date_to: '2026-05-31',
    });
  });

  it('ensures the export_jobs table exists at startup (lazy DDL, greenfield-safe)', async () => {
    const prisma = makePrismaStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new ExportJobsService(prisma as any, makeEnv());
    await svc.create('42', {});
    const ddl = prisma.calls.find((c) => /CREATE TABLE IF NOT EXISTS export_jobs/.test(c.sql));
    expect(ddl).toBeDefined();
  });
});

describe('ExportJobsService.markRunning / markDone / markFailed', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let svc: ExportJobsService;

  beforeEach(() => {
    prisma = makePrismaStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = new ExportJobsService(prisma as any, makeEnv());
  });

  it('markRunning issues UPDATE with status=running', async () => {
    await svc.markRunning('job-1');
    const call = prisma.calls.find((c) => /SET status='running'/.test(c.sql));
    expect(call).toBeDefined();
    expect(call!.values[0]).toBe('job-1');
  });

  it('markDone updates status=done + URL + expires_at', async () => {
    const expiresAt = new Date('2026-06-01T12:00:00Z');
    await svc.markDone('job-2', 'https://blob/x?sas', expiresAt);
    const call = prisma.calls.find((c) => /SET status='done'/.test(c.sql));
    expect(call).toBeDefined();
    expect(call!.values).toEqual(['job-2', 'https://blob/x?sas', '2026-06-01T12:00:00.000Z']);
  });

  it('markFailed clamps error message to 1000 chars', async () => {
    await svc.markFailed('job-3', 'x'.repeat(2000));
    const call = prisma.calls.find((c) => /SET status='failed'/.test(c.sql));
    expect(call).toBeDefined();
    expect((call!.values[1] as string).length).toBe(1000);
  });
});

describe('ExportJobsService.get — RBAC by actor_user_id', () => {
  it('returns null when the job does not exist (or actor is not the owner)', async () => {
    const prisma = makePrismaStub({ existingJob: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new ExportJobsService(prisma as any, makeEnv());
    const row = await svc.get('job-missing', '42');
    expect(row).toBeNull();
    // The SELECT must include both id AND actor_user_id predicates.
    const select = prisma.calls.find((c) => /FROM export_jobs/.test(c.sql) && /SELECT id, actor_user_id/.test(c.sql));
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(/WHERE id = \$1::uuid AND actor_user_id = \$2::bigint/);
  });

  it('returns the job row when owner queries — normalises dates to ISO', async () => {
    const prisma = makePrismaStub({
      existingJob: {
        id: 'job-1',
        actor_user_id: BigInt(42),
        status: 'done',
        filter: { date_from: '2026-05-01' },
        download_url: 'https://x/y?sas',
        expires_at: '2026-06-01T12:00:00.000Z',
        error: null,
        created_at: '2026-05-22T10:00:00.000Z',
        updated_at: '2026-05-22T10:05:00.000Z',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new ExportJobsService(prisma as any, makeEnv());
    const row = await svc.get('job-1', '42');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('done');
    expect(row!.actor_user_id).toBe('42');
    expect(row!.download_url).toBe('https://x/y?sas');
    expect(row!.expires_at).toMatch(/^2026-06-01T12:00:00/);
  });
});

describe('ExportJobsService.uploadAndSign — dev fallback', () => {
  it('returns a data: URL stub when BLOB_STORAGE_CONNECTION_STRING is unset', async () => {
    const prisma = makePrismaStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new ExportJobsService(prisma as any, makeEnv());
    const result = await svc.uploadAndSign('42', 'demo.xlsx', Buffer.from('PK\x03\x04dummy'));
    expect(result.url.startsWith('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,')).toBe(true);
    expect(result.expiresAt).toBeInstanceOf(Date);
    // 5-minute TTL (within tolerance).
    expect(result.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
    expect(result.expiresAt.getTime() - Date.now()).toBeLessThan(310_000);
  });
});
