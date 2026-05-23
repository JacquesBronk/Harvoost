import { describe, it, expect, vi } from 'vitest';
import { SchedulesController } from '../../src/schedules/schedules.controller';
import { RbacForbiddenError, ValidationFailedError } from '@harvoost/shared';

// INC-004 Row 3 — GET /v1/schedules/dashboard.
// Asserts: tab validation, RBAC per tab, envelope `{ data, scope_meta }`,
// template/override composition + source precedence.

function makePrismaStub(opts: {
  templates?: Array<Record<string, unknown>>;
  overrides?: Array<Record<string, unknown>>;
} = {}) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM users u') && sql.includes('schedule_templates st')) {
        return opts.templates ?? [];
      }
      if (sql.includes('FROM schedule_overrides so')) {
        return opts.overrides ?? [];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbacStub(opts: { unrestricted?: boolean; visibleUsers?: string[]; canSeeUser?: boolean } = {}) {
  return {
    getVisibleUserIds: vi.fn(async () => ({
      unrestricted: opts.unrestricted ?? false,
      userIds: opts.visibleUsers ?? ['10', '20'],
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    getVisibleProjectIds: vi.fn(async () => ({
      unrestricted: opts.unrestricted ?? false,
      projectIds: [],
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    assertCanSeeUser: vi.fn(async () => {
      if (opts.canSeeUser === false) throw new RbacForbiddenError();
    }),
    assertCanSeeProject: vi.fn(async () => undefined),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

function makeCtrl(prisma: unknown, rbac: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SchedulesController(prisma as any, rbac as any, makeAuditStub() as any);
}

const manager = { userId: '10', email: 'm@x', roles: ['manager'] };
const admin = { userId: '1', email: 'a@x', roles: ['admin'] };
const employee = { userId: '30', email: 'e@x', roles: ['employee'] };

const aliceTemplate = {
  user_id: '10',
  display_name: 'Alice',
  working_days: [1, 2, 3, 4, 5],
  start_time: '08:00:00',
  end_time: '17:00:00',
  lunch_start_time: '12:00:00',
  lunch_end_time: '13:00:00',
};

describe('schedules/dashboard — validation', () => {
  it('rejects an invalid tab', async () => {
    const ctrl = makeCtrl(makePrismaStub(), makeRbacStub());
    await expect(
      ctrl.dashboard(admin, 'nope', undefined, '2026-06-01', '2026-06-02'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a malformed date_from', async () => {
    const ctrl = makeCtrl(makePrismaStub(), makeRbacStub());
    await expect(
      ctrl.dashboard(admin, 'company', undefined, 'bad', '2026-06-02'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects date_to < date_from', async () => {
    const ctrl = makeCtrl(makePrismaStub(), makeRbacStub());
    await expect(
      ctrl.dashboard(admin, 'company', undefined, '2026-06-10', '2026-06-01'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('schedules/dashboard — RBAC per tab', () => {
  it('tab=company is rejected for a non-admin/finmgr', async () => {
    const ctrl = makeCtrl(makePrismaStub(), makeRbacStub());
    await expect(
      ctrl.dashboard(manager, 'company', undefined, '2026-06-01', '2026-06-02'),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('tab=company allowed for admin', async () => {
    const ctrl = makeCtrl(makePrismaStub({ templates: [aliceTemplate] }), makeRbacStub({ unrestricted: true }));
    const out = await ctrl.dashboard(admin, 'company', undefined, '2026-06-01', '2026-06-01');
    expect(out.scope_meta.visible_users).toBe('all');
    expect(Array.isArray(out.data)).toBe(true);
  });

  it('tab=team scopes to getVisibleUserIds', async () => {
    const rbac = makeRbacStub({ visibleUsers: ['10'] });
    const ctrl = makeCtrl(makePrismaStub({ templates: [aliceTemplate] }), rbac);
    const out = await ctrl.dashboard(manager, 'team', undefined, '2026-06-01', '2026-06-01');
    expect(rbac.getVisibleUserIds).toHaveBeenCalledWith('10');
    expect(out.data.every((r) => r.user_id === '10')).toBe(true);
  });

  it('tab=team with empty scope returns an empty grid (not an error)', async () => {
    const rbac = makeRbacStub({ visibleUsers: [] });
    const ctrl = makeCtrl(makePrismaStub(), rbac);
    const out = await ctrl.dashboard(employee, 'team', undefined, '2026-06-01', '2026-06-30');
    expect(out.data).toEqual([]);
    expect(out.scope_meta.visible_users).toBe(0);
  });

  it('tab=individual requires user_id', async () => {
    const ctrl = makeCtrl(makePrismaStub(), makeRbacStub());
    await expect(
      ctrl.dashboard(manager, 'individual', undefined, '2026-06-01', '2026-06-02'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('tab=individual 403s when the target is out of scope', async () => {
    const rbac = makeRbacStub({ canSeeUser: false });
    const ctrl = makeCtrl(makePrismaStub(), rbac);
    await expect(
      ctrl.dashboard(manager, 'individual', '99', '2026-06-01', '2026-06-02'),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('tab=individual allowed when target is in scope', async () => {
    const rbac = makeRbacStub({ canSeeUser: true });
    const bobTemplate = { ...aliceTemplate, user_id: '20', display_name: 'Bob' };
    const ctrl = makeCtrl(makePrismaStub({ templates: [bobTemplate] }), rbac);
    // Manager (id 10) requesting another in-scope user (id 20) → assertCanSeeUser fires.
    const out = await ctrl.dashboard(manager, 'individual', '20', '2026-06-01', '2026-06-01');
    expect(rbac.assertCanSeeUser).toHaveBeenCalledWith('10', '20');
    expect(out.data.every((r) => r.user_id === '20')).toBe(true);
  });
});

describe('schedules/dashboard — composition', () => {
  it('emits template rows only on working days, computing hours minus lunch', async () => {
    // 2026-06-01 is a Monday; 2026-06-06 is a Saturday (not a working day).
    const ctrl = makeCtrl(
      makePrismaStub({ templates: [aliceTemplate] }),
      makeRbacStub({ unrestricted: true }),
    );
    const out = await ctrl.dashboard(admin, 'company', undefined, '2026-06-01', '2026-06-07');
    // Mon-Fri only (5 working days), Sat+Sun skipped.
    expect(out.data).toHaveLength(5);
    const monday = out.data.find((r) => r.local_date === '2026-06-01');
    expect(monday).toBeDefined();
    expect(monday!.source).toBe('template');
    expect(monday!.scheduled_start).toBe('08:00');
    expect(monday!.scheduled_end).toBe('17:00');
    // 09:00 span minus 1h lunch = 8h.
    expect(monday!.scheduled_hours).toBe(8);
  });

  it('a covering user-scope override wins over the template', async () => {
    const ctrl = makeCtrl(
      makePrismaStub({
        templates: [aliceTemplate],
        overrides: [
          {
            scope: 'user',
            user_id: '10',
            effective_from: '2026-06-01',
            effective_to: '2026-06-30',
            start_time: '10:00:00',
            end_time: '16:00:00',
            lunch_start_time: null,
            lunch_end_time: null,
            reason: 'Reduced hours',
          },
        ],
      }),
      makeRbacStub({ unrestricted: true }),
    );
    const out = await ctrl.dashboard(admin, 'company', undefined, '2026-06-01', '2026-06-01');
    expect(out.data).toHaveLength(1);
    expect(out.data[0].source).toBe('user_override');
    expect(out.data[0].scheduled_start).toBe('10:00');
    expect(out.data[0].scheduled_end).toBe('16:00');
    expect(out.data[0].scheduled_hours).toBe(6);
    expect(out.data[0].override_reason).toBe('Reduced hours');
  });

  it('an org-scope override applies when no user-scope override covers the day', async () => {
    const ctrl = makeCtrl(
      makePrismaStub({
        templates: [aliceTemplate],
        overrides: [
          {
            scope: 'org',
            user_id: null,
            effective_from: '2026-06-01',
            effective_to: '2026-06-30',
            start_time: '09:00:00',
            end_time: '14:00:00',
            lunch_start_time: null,
            lunch_end_time: null,
            reason: 'Company half-day',
          },
        ],
      }),
      makeRbacStub({ unrestricted: true }),
    );
    const out = await ctrl.dashboard(admin, 'company', undefined, '2026-06-01', '2026-06-01');
    expect(out.data[0].source).toBe('org_override');
    expect(out.data[0].scheduled_hours).toBe(5);
  });
});
