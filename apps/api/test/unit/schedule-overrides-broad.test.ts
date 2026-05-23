import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulesController } from '../../src/schedules/schedules.controller';
import { RbacForbiddenError, ValidationFailedError } from '@harvoost/shared';

// Item 7: broad schedule overrides — RBAC + scope-target consistency + conflict.

function makePrismaStub(opts: { override?: { scope: string; user_id?: string; project_id?: string }; insertThrows?: 'overlap' | false } = {}) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM schedule_overrides') && sql.includes('LIMIT 1')) {
        return opts.override ? [opts.override] : [];
      }
      if (opts.insertThrows === 'overlap' && sql.includes('INSERT INTO schedule_overrides')) {
        throw Object.assign(new Error('conflicting key value violates exclusion constraint "so_no_overlap"'), { code: '23P01' });
      }
      if (sql.includes('INSERT INTO schedule_overrides')) {
        return [
          {
            id: 42,
            scope: 'user',
            user_id: null,
            project_id: null,
            effective_from: '2026-06-01',
            effective_to: '2026-06-30',
            start_time: '09:00:00',
            end_time: '18:00:00',
            lunch_start_time: null,
            lunch_end_time: null,
            reason: 'Cover for vacation period',
            created_by: 10,
            created_at: '2026-05-23T00:00:00.000Z',
          },
        ];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbacStub(opts: { allowSee?: boolean; visibleUsers?: string[] } = {}) {
  const allow = opts.allowSee ?? true;
  return {
    assertCanSeeUser: vi.fn(async () => {
      if (!allow) throw new RbacForbiddenError();
    }),
    assertCanSeeProject: vi.fn(async () => undefined),
    getVisibleUserIds: vi.fn(async () => ({
      userIds: opts.visibleUsers ?? [],
      unrestricted: false,
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    getVisibleProjectIds: vi.fn(async () => ({
      projectIds: [],
      unrestricted: false,
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

// INC-004 Row 6: the create-override body now follows the spec shape
// (effective_from/effective_to/start_time/end_time/user_id/project_id).
const baseBody = {
  scope: 'user' as const,
  user_id: '20',
  effective_from: '2026-06-01',
  effective_to: '2026-06-30',
  start_time: '09:00',
  end_time: '18:00',
  reason: 'Cover for vacation period',
};

describe('SchedulesController createOverride — RBAC + validation', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let rbac: ReturnType<typeof makeRbacStub>;
  let audit: ReturnType<typeof makeAuditStub>;
  let ctrl: SchedulesController;

  beforeEach(() => {
    prisma = makePrismaStub();
    rbac = makeRbacStub();
    audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new SchedulesController(prisma as any, rbac as any, audit as any);
  });

  it('scope=user: manager can override for visible employee', async () => {
    const res = await ctrl.createOverride(
      { userId: '10', email: 'm@x', roles: ['manager'] },
      baseBody,
    );
    expect(res.id).toBe('42');
    expect(res.scope).toBe('user');
    expect(res.effective_from).toBe('2026-06-01');
    expect(res.start_time).toBe('09:00');
    expect(rbac.assertCanSeeUser).toHaveBeenCalledWith('10', '20');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'schedule.override_create' }),
    );
  });

  it('scope=user: rejected when manager cannot see target', async () => {
    rbac = makeRbacStub({ allowSee: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new SchedulesController(prisma as any, rbac as any, audit as any);
    await expect(
      ctrl.createOverride({ userId: '10', email: 'm@x', roles: ['manager'] }, baseBody),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('scope=user: employee (no manager role) is rejected', async () => {
    await expect(
      ctrl.createOverride({ userId: '10', email: 'e@x', roles: ['employee'] }, baseBody),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('scope=project: admin allowed (maps project_id, not user_id)', async () => {
    // user_id must be dropped from the user-shaped baseBody for project scope.
    const { user_id: _omit, ...rest } = baseBody;
    const res = await ctrl.createOverride(
      { userId: '1', email: 'a@x', roles: ['admin'] },
      { ...rest, scope: 'project', project_id: '5' },
    );
    expect(res.id).toBe('42');
  });

  it('scope=project: manager rejected (admin/finmgr only)', async () => {
    const { user_id: _omit, ...rest } = baseBody;
    await expect(
      ctrl.createOverride(
        { userId: '10', email: 'm@x', roles: ['manager'] },
        { ...rest, scope: 'project', project_id: '5' },
      ),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('scope=org: user_id/project_id must be omitted', async () => {
    await expect(
      ctrl.createOverride(
        { userId: '1', email: 'a@x', roles: ['admin'] },
        { ...baseBody, scope: 'org' },
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('scope=org: admin can create org-wide override', async () => {
    const res = await ctrl.createOverride(
      { userId: '1', email: 'a@x', roles: ['admin'] },
      { scope: 'org', effective_from: '2026-07-01', effective_to: '2026-07-31', start_time: '09:00', end_time: '17:00', reason: 'July policy' },
    );
    expect(res.id).toBe('42');
  });

  it('rejects malformed time strings', async () => {
    await expect(
      ctrl.createOverride(
        { userId: '1', email: 'a@x', roles: ['admin'] },
        { scope: 'org', effective_from: '2026-07-01', effective_to: '2026-07-31', start_time: '25:00', end_time: '17:00', reason: 'July policy' },
      ),
    ).rejects.toThrow();
  });

  it('overlapping window for same scope/target is rejected at create time', async () => {
    prisma = makePrismaStub({ insertThrows: 'overlap' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new SchedulesController(prisma as any, rbac as any, audit as any);
    await expect(
      ctrl.createOverride({ userId: '10', email: 'm@x', roles: ['manager'] }, baseBody),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('SchedulesController deleteOverride — RBAC', () => {
  it('manager can delete a user-scope override they can see', async () => {
    const prisma = makePrismaStub({ override: { scope: 'user', user_id: '20' } });
    const rbac = makeRbacStub({ allowSee: true });
    const audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new SchedulesController(prisma as any, rbac as any, audit as any);
    const r = await ctrl.deleteOverride({ userId: '10', email: 'm@x', roles: ['manager'] }, '42');
    expect(r).toEqual({ ok: true });
  });

  it('manager cannot delete a project-scope override', async () => {
    const prisma = makePrismaStub({ override: { scope: 'project', project_id: '5' } });
    const rbac = makeRbacStub();
    const audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new SchedulesController(prisma as any, rbac as any, audit as any);
    await expect(
      ctrl.deleteOverride({ userId: '10', email: 'm@x', roles: ['manager'] }, '42'),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });
});
