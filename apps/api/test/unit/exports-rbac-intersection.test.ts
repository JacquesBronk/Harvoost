import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExportsController } from '../../src/exports/exports.controller';

// Item 10: caller-supplied user_ids/project_ids intersect with RBAC scope.
// This closes SECURITY M10. We mock prisma to return 0 rows so the sync path
// returns a download URL stub, and we assert the COUNT + SELECT both bind the
// INTERSECTED arrays — never the raw client-supplied arrays.

function makePrismaStub() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $queryRawUnsafe: vi.fn(async function (this: unknown, sql: string, ...values: unknown[]) {
      calls.push({ sql, values });
      if (/SELECT COUNT\(\*\)/.test(sql)) {
        return [{ n: BigInt(0) }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbacStub(opts: { visibleUsers?: string[]; visibleProjects?: string[] }) {
  return {
    getVisibleUserIds: vi.fn(async () => ({
      userIds: opts.visibleUsers ?? [],
      unrestricted: false,
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    getVisibleProjectIds: vi.fn(async () => ({
      projectIds: opts.visibleProjects ?? [],
      unrestricted: false,
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
  };
}

function makeWriter() {
  return { writeBuffer: vi.fn(async () => Buffer.from('xlsx-data')) };
}

function makeJobs() {
  return {
    uploadAndSign: vi.fn(async () => ({ url: 'https://blob/x?sas', expiresAt: new Date(Date.now() + 300_000) })),
    create: vi.fn(async () => ({ jobId: 'job-1' })),
    get: vi.fn(),
  };
}

describe('ExportsController — RBAC intersection (M10)', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let rbac: ReturnType<typeof makeRbacStub>;
  let writer: ReturnType<typeof makeWriter>;
  let jobs: ReturnType<typeof makeJobs>;
  let ctrl: ExportsController;

  beforeEach(() => {
    prisma = makePrismaStub();
    rbac = makeRbacStub({ visibleUsers: ['10', '20'], visibleProjects: ['100', '200'] });
    writer = makeWriter();
    jobs = makeJobs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new ExportsController(prisma as any, rbac as any, writer as any, jobs as any);
  });

  it('intersects user_ids — non-visible IDs are dropped before SQL', async () => {
    await ctrl.excel(
      { userId: '5', email: 'm@x', roles: ['manager'] },
      // 30 is NOT in the visible set ['10','20'] — must be filtered out.
      { date_from: '2026-05-01', date_to: '2026-05-31', user_ids: ['10', '30'] },
    );
    const countCall = prisma.calls.find((c) => /COUNT\(\*\)/.test(c.sql))!;
    // user_ids param should be the INTERSECTION, not the raw input.
    const userArrayParam = countCall.values.find((v) => Array.isArray(v) && (v as string[]).every((x) => /^\d+$/.test(x)));
    expect(userArrayParam).toEqual(['10']);
  });

  it('intersects project_ids — non-visible projects are dropped', async () => {
    await ctrl.excel(
      { userId: '5', email: 'm@x', roles: ['manager'] },
      { date_from: '2026-05-01', date_to: '2026-05-31', project_ids: ['100', '999'] },
    );
    const countCall = prisma.calls.find((c) => /COUNT\(\*\)/.test(c.sql))!;
    // Project array param appears AFTER user array; find by content.
    const arrays = countCall.values.filter((v) => Array.isArray(v));
    expect(arrays.flat()).toContain('100');
    expect(arrays.flat()).not.toContain('999');
  });

  it('when caller omits user_ids, defaults to the full visible set', async () => {
    await ctrl.excel(
      { userId: '5', email: 'm@x', roles: ['manager'] },
      { date_from: '2026-05-01', date_to: '2026-05-31' },
    );
    const countCall = prisma.calls.find((c) => /COUNT\(\*\)/.test(c.sql))!;
    const userArrayParam = countCall.values.find((v) => Array.isArray(v) && (v as string[]).every((x) => /^\d+$/.test(x)) && (v as string[]).length === 2);
    expect(userArrayParam).toEqual(['10', '20']);
  });

  it('admin (unrestricted) does not narrow user_ids', async () => {
    rbac.getVisibleUserIds = vi.fn(async () => ({
      userIds: [],
      unrestricted: true,
      meta: { fromProjects: 0, fromPersons: 0 },
    }));
    rbac.getVisibleProjectIds = vi.fn(async () => ({
      projectIds: [],
      unrestricted: true,
      meta: { fromProjects: 0, fromPersons: 0 },
    }));
    await ctrl.excel(
      { userId: '1', email: 'a@x', roles: ['admin'] },
      { date_from: '2026-05-01', date_to: '2026-05-31', user_ids: ['10', '20', '30'] },
    );
    const countCall = prisma.calls.find((c) => /COUNT\(\*\)/.test(c.sql))!;
    // admin: caller-supplied user_ids pass through verbatim.
    const userArrayParam = countCall.values.find((v) => Array.isArray(v));
    expect(userArrayParam).toEqual(['10', '20', '30']);
  });
});
