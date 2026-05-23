import { describe, it, expect, vi } from 'vitest';
import { ProjectsController } from '../../src/projects/projects.controller';
import { RolesGuard } from '../../src/auth/roles.guard';
import { ROLES_KEY } from '../../src/common/roles.decorator';
import { RbacForbiddenError } from '@harvoost/shared';
import { Reflector } from '@nestjs/core';

// INC-004 expansion — ProjectsController members/managers list + delete.
// The 4 routes are admin-only (RolesGuard reads the @Roles('admin') metadata),
// the GETs return the OffsetPaginated<{...}> envelope with the exact fields the
// admin UI reads, and the DELETEs mutate the row + record an audit entry.

function makePrismaStub(opts: { rows?: Array<Record<string, unknown>>; total?: number } = {}) {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  return {
    executed,
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return [{ n: opts.total ?? opts.rows?.length ?? 0 }];
      return opts.rows ?? [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      executed.push({ sql, values });
      return 1;
    }),
  };
}

function makeRbacStub() {
  return {
    getVisibleProjectIds: vi.fn(async () => ({ projectIds: [], unrestricted: true })),
    assertCanSeeProject: vi.fn(async () => undefined),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

const admin = { userId: '1', email: 'a@x', roles: ['admin'] };

// Drives the real RolesGuard with a synthetic ExecutionContext pointing at a
// controller handler, so we exercise the same metadata the live request path
// uses (rather than re-implementing the role check in the test).
function runGuard(handler: (...args: unknown[]) => unknown, user: { roles: string[] } | undefined) {
  const guard = new RolesGuard(new Reflector());
  const ctx = {
    getHandler: () => handler,
    getClass: () => ProjectsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
  return guard.canActivate(ctx);
}

describe('ProjectsController — members/managers RBAC', () => {
  it('all 4 routes carry @Roles(admin) metadata', () => {
    for (const name of ['listMembers', 'removeMember', 'listManagers', 'removeManager'] as const) {
      const roles = Reflect.getMetadata(ROLES_KEY, ProjectsController.prototype[name]);
      expect(roles).toEqual(['admin']);
    }
  });

  it('RolesGuard 403s a non-admin (employee) on listMembers', () => {
    expect(() => runGuard(ProjectsController.prototype.listMembers, { roles: ['employee'] })).toThrow(
      RbacForbiddenError,
    );
  });

  it('RolesGuard 403s a manager on removeMember', () => {
    expect(() => runGuard(ProjectsController.prototype.removeMember, { roles: ['manager'] })).toThrow(
      RbacForbiddenError,
    );
  });

  it('RolesGuard allows an admin on listManagers', () => {
    expect(runGuard(ProjectsController.prototype.listManagers, admin)).toBe(true);
  });
});

describe('ProjectsController.listMembers', () => {
  it('returns OffsetPaginated<ProjectMember> with the FE-read fields, IDs stringified', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 7,
          project_id: 5,
          user_id: 42,
          user_display_name: 'Ada Lovelace',
          user_email: 'ada@x.io',
          joined_at: '2026-01-01',
          left_at: null,
        },
      ],
      total: 1,
    });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub() as never, makeAuditStub() as never);
    const out = await ctrl.listMembers('5', '1', '50');
    expect(out).toMatchObject({ page: 1, page_size: 50, total_count: 1 });
    expect(out.data[0]).toEqual({
      id: '7',
      project_id: '5',
      user_id: '42',
      user_display_name: 'Ada Lovelace',
      user_email: 'ada@x.io',
      joined_at: '2026-01-01',
      left_at: null,
    });
    // Active-only filter is part of the contract (mirrors the partial unique index).
    const listSql = prisma.$queryRawUnsafe.mock.calls.map((c) => c[0] as string).find((s) => s.includes('JOIN users'));
    expect(listSql).toContain('left_at IS NULL');
  });
});

describe('ProjectsController.listManagers', () => {
  it('returns OffsetPaginated<ProjectManagerAnchor> with manager_* fields', async () => {
    const prisma = makePrismaStub({
      rows: [
        {
          id: 3,
          project_id: 5,
          manager_id: 9,
          manager_display_name: 'Grace Hopper',
          manager_email: 'grace@x.io',
          assigned_at: '2026-02-02T00:00:00.000Z',
        },
      ],
      total: 1,
    });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub() as never, makeAuditStub() as never);
    const out = await ctrl.listManagers('5', '1', '50');
    expect(out.total_count).toBe(1);
    expect(out.data[0]).toEqual({
      id: '3',
      project_id: '5',
      manager_id: '9',
      manager_display_name: 'Grace Hopper',
      manager_email: 'grace@x.io',
      assigned_at: '2026-02-02T00:00:00.000Z',
    });
  });
});

describe('ProjectsController.removeMember', () => {
  it('soft-deletes the active membership (left_at) and records project.member_remove audit', async () => {
    const prisma = makePrismaStub();
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub() as never, audit as never);
    const r = await ctrl.removeMember(admin, '5', '42');
    expect(r).toEqual({ ok: true });
    const stmt = prisma.executed[0]!;
    expect(stmt.sql).toContain('UPDATE project_members SET left_at');
    expect(stmt.sql).toContain('left_at IS NULL');
    expect(stmt.values).toEqual(['5', '42']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.member_remove',
        entityType: 'project',
        entityId: '5',
        actorId: '1',
        after: { user_id: '42' },
      }),
    );
  });
});

describe('ProjectsController.removeManager', () => {
  it('hard-deletes the manager row and records project.manager_remove audit', async () => {
    const prisma = makePrismaStub();
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub() as never, audit as never);
    const r = await ctrl.removeManager(admin, '5', '9');
    expect(r).toEqual({ ok: true });
    const stmt = prisma.executed[0]!;
    expect(stmt.sql).toContain('DELETE FROM project_managers');
    expect(stmt.values).toEqual(['5', '9']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.manager_remove',
        entityType: 'project',
        entityId: '5',
        actorId: '1',
        after: { manager_id: '9' },
      }),
    );
  });
});
