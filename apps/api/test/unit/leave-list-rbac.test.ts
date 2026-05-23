import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaveController } from '../../src/leave/leave.controller';

// Item 3 (M5): leave-list manager fan-out.
//   - employee sees only own (WHERE user_id = $1)
//   - manager sees own + RBAC-visible users (WHERE user_id = ANY(...))
//   - admin/finmgr see all (no user filter)

function makePrismaStub(rowsReturned: Array<Record<string, unknown>> = []) {
  return {
    capturedSql: [] as Array<{ sql: string; values: unknown[] }>,
    $queryRawUnsafe: vi.fn(async function (this: { capturedSql: Array<{ sql: string; values: unknown[] }> }, sql: string, ...values: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).capturedSql.push({ sql, values });
      return rowsReturned;
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbacStub(opts: { visibleUserIds?: string[]; unrestricted?: boolean }) {
  return {
    getVisibleUserIds: vi.fn(async () => ({
      userIds: opts.visibleUserIds ?? [],
      unrestricted: opts.unrestricted ?? false,
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    assertCanSeeUser: vi.fn(async () => undefined),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

describe('LeaveController.list — M5 manager fan-out', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let rbac: ReturnType<typeof makeRbacStub>;
  let audit: ReturnType<typeof makeAuditStub>;
  let ctrl: LeaveController;

  beforeEach(() => {
    prisma = makePrismaStub();
    rbac = makeRbacStub({ visibleUserIds: ['10', '20', '30'] });
    audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new LeaveController(prisma as any, rbac as any, audit as any);
    // shim: capturedSql lives on prisma
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.$queryRawUnsafe = vi.fn(async (sql: string, ...values: unknown[]) => {
      prisma.capturedSql.push({ sql, values });
      return [];
    });
  });

  it('employee: filters by self only (WHERE user_id = $1::bigint)', async () => {
    const res = await ctrl.list({ userId: '10', email: 'e@x', roles: ['employee'] });
    expect(res.scope_meta).toEqual({ visible_users: 1 });
    expect(prisma.capturedSql).toHaveLength(1);
    expect(prisma.capturedSql[0]!.sql).toMatch(/WHERE user_id = \$1::bigint/i);
    expect(prisma.capturedSql[0]!.values).toEqual(['10']);
  });

  it('manager: fans out via RBAC visible-users (user_id = ANY(...))', async () => {
    const res = await ctrl.list({ userId: '10', email: 'm@x', roles: ['manager'] });
    expect(rbac.getVisibleUserIds).toHaveBeenCalledWith('10');
    expect(res.scope_meta).toEqual({ visible_users: 3 });
    const insertedSql = prisma.capturedSql[0]!;
    expect(insertedSql.sql).toMatch(/user_id = ANY\(\$1::bigint\[\]\)/i);
    expect(insertedSql.values).toEqual([['10', '20', '30']]);
  });

  it('admin: no user filter (returns org-wide)', async () => {
    const res = await ctrl.list({ userId: '1', email: 'a@x', roles: ['admin'] });
    expect(res.scope_meta).toEqual({ visible_users: 'all' });
    const sql = prisma.capturedSql[0]!.sql;
    expect(sql).not.toMatch(/WHERE user_id/i);
    expect(sql).toMatch(/FROM leave_requests/);
  });

  it('finmgr: same as admin — org-wide visibility', async () => {
    const res = await ctrl.list({ userId: '2', email: 'f@x', roles: ['finmgr'] });
    expect(res.scope_meta).toEqual({ visible_users: 'all' });
  });

  it('manager with zero visible users returns empty (does not query)', async () => {
    rbac = makeRbacStub({ visibleUserIds: [], unrestricted: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new LeaveController(prisma as any, rbac as any, audit as any);
    const res = await ctrl.list({ userId: '10', email: 'm@x', roles: ['manager'] });
    expect(res.data).toEqual([]);
  });
});
