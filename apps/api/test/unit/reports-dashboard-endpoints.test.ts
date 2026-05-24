import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportsController } from '../../src/reports/reports.controller';
import { RbacForbiddenError, ValidationFailedError } from '@harvoost/shared';

// Smoke tests for the 4 new manager/financial dashboard endpoints.
// These assert RBAC gating, query-shape correctness, and the date_range parser.

function makePrismaStub(data: Record<string, unknown[]> = {}) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      // Match on substring of the SQL.
      for (const [key, rows] of Object.entries(data)) {
        if (sql.includes(key)) return rows;
      }
      return [];
    }),
  };
}

function makeRbacStub(opts: { unrestricted?: boolean; visibleUserIds?: string[]; visibleProjectIds?: string[]; canSeeUser?: boolean; canSeeProject?: boolean } = {}) {
  return {
    getVisibleUserIds: vi.fn(async () => ({
      unrestricted: opts.unrestricted ?? false,
      userIds: opts.visibleUserIds ?? ['1', '2'],
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    getVisibleProjectIds: vi.fn(async () => ({
      unrestricted: opts.unrestricted ?? false,
      projectIds: opts.visibleProjectIds ?? ['10', '20'],
      meta: { fromProjects: 0, fromPersons: 0 },
    })),
    assertCanSeeUser: vi.fn(async () => {
      if (opts.canSeeUser === false) throw new RbacForbiddenError();
    }),
    assertCanSeeProject: vi.fn(async () => {
      if (opts.canSeeProject === false) throw new RbacForbiddenError();
    }),
  };
}

const actor = { userId: '1', email: 'mgr@example.com', roles: ['manager'] };
const admin = { userId: '1', email: 'admin@example.com', roles: ['admin'] };

describe('parseDateRange via team-dashboard', () => {
  it('throws ValidationFailedError when date_range is missing', async () => {
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makePrismaStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRbacStub() as any,
    );
    await expect(ctrl.teamDashboard(actor, undefined)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('throws ValidationFailedError when date_range is malformed', async () => {
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makePrismaStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRbacStub() as any,
    );
    await expect(ctrl.teamDashboard(actor, 'not-a-range')).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('throws when from > to', async () => {
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makePrismaStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRbacStub() as any,
    );
    await expect(ctrl.teamDashboard(actor, '2026-05-31/2026-05-01')).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('teamDashboard — RBAC scoping + shape', () => {
  it('returns per-user rollup sorted by display_name', async () => {
    const prisma = makePrismaStub({
      'FROM time_entries te\n       JOIN users u': [
        { user_id: '1', display_name: 'Alice', total_hours: 8, billable_hours: 6, non_billable_hours: 2 },
        { user_id: '2', display_name: 'Bob', total_hours: 7, billable_hours: 7, non_billable_hours: 0 },
      ],
      'PARTITION BY te.user_id': [],
      'FROM exceptions e': [],
    });
    const rbac = makeRbacStub();
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.teamDashboard(actor, '2026-05-01/2026-05-31');
    // INC-004 Row 1: envelope key is `items` (was `data`).
    expect(out.items).toHaveLength(2);
    expect(out.items[0].display_name).toBe('Alice');
    expect(out.items[1].display_name).toBe('Bob');
    expect(out.scope_meta.visible_users).toBe(2);
    expect(rbac.getVisibleUserIds).toHaveBeenCalledWith('1');
  });
});

describe('profitability — admin/finmgr only', () => {
  // The @Roles decorator is enforced by RolesGuard at the framework level,
  // so a direct unit-test call does not exercise it. We can still verify the
  // controller behaviour given an admin actor.
  it('aggregates per-project revenue/cost/margin and sorts by margin_pct ascending', async () => {
    const prisma = makePrismaStub({
      'FROM projects p': [
        // High margin
        { project_id: '1', project_name: 'A', billing_mode: 'hourly', fixed_fee_amount: null, currency: 'EUR', total_hours: 10, billable_hours: 10, cost: 500, hourly_revenue: 2000 },
        // Low margin
        { project_id: '2', project_name: 'B', billing_mode: 'hourly', fixed_fee_amount: null, currency: 'EUR', total_hours: 10, billable_hours: 10, cost: 1500, hourly_revenue: 1600 },
      ],
      'FROM project_billing_mode_history': [],
    });
    const rbac = makeRbacStub({ unrestricted: true });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.profitability('2026-05-01/2026-05-31');
    // INC-004 Row 2: envelope key is `items`; row fields are `project_name`/`hours`.
    expect(out.items).toHaveLength(2);
    // Lowest margin_pct first (B has 6.25% margin; A has 75% margin)
    expect(out.items[0].project_id).toBe('2');
    expect(out.items[1].project_id).toBe('1');
    expect(out.items[0].margin).toBe(100); // 1600 - 1500
    expect(out.items[1].margin).toBe(1500); // 2000 - 500
    // Field renames: project_name (was name), hours (was hours_total).
    expect(out.items[0].project_name).toBe('B');
    expect(out.items[1].project_name).toBe('A');
    expect(out.items[0]).toHaveProperty('hours');
    expect(out.items[0]).not.toHaveProperty('name');
    expect(out.items[0]).not.toHaveProperty('hours_total');
  });

  it('treats fixed_fee billing mode as one-time revenue, not per-entry', async () => {
    const prisma = makePrismaStub({
      'FROM projects p': [
        { project_id: '1', project_name: 'F', billing_mode: 'fixed_fee', fixed_fee_amount: 10000, currency: 'EUR', total_hours: 50, billable_hours: 50, cost: 2500, hourly_revenue: 999999 },
      ],
      'FROM project_billing_mode_history': [],
    });
    const rbac = makeRbacStub({ unrestricted: true });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.profitability('2026-05-01/2026-05-31');
    // Revenue = fixed_fee_amount, NOT the (incorrect) hourly_revenue value.
    expect(out.items[0].revenue).toBe(10000);
    expect(out.items[0].margin).toBe(7500);
  });
});

describe('employees rollup — RBAC + out-of-scope summarisation', () => {
  it('asserts canSeeUser before running queries', async () => {
    const rbac = makeRbacStub({ canSeeUser: false });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makePrismaStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    await expect(
      ctrl.employeeRollup(actor, '99', '2026-05-01/2026-05-31'),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('lists only in-scope projects and surfaces out-of-scope as top-level numbers', async () => {
    const prisma = makePrismaStub({
      // Header
      'SELECT id, display_name, email, timezone': [
        { id: 2, display_name: 'Bob', email: 'bob@example.com', timezone: 'Africa/Johannesburg' },
      ],
      // Per-project hours
      'JOIN projects p ON p.id = te.project_id': [
        { project_id: '10', project_name: 'Visible-A', hours: 4 },
        { project_id: '99', project_name: 'Invisible-X', hours: 3 },
        { project_id: '88', project_name: 'Invisible-Y', hours: 2 },
      ],
      // Timeline
      'GROUP BY day': [{ day: '2026-05-15', hours: 9 }],
      // Exceptions
      'FROM exceptions': [],
    });
    const rbac = makeRbacStub({ visibleProjectIds: ['10'], visibleUserIds: ['1', '2'] });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.employeeRollup(actor, '2', '2026-05-01/2026-05-31');
    // Only the real in-scope project remains in the array — NO synthetic
    // null-id "Other projects (N)" row.
    expect(out.hours_by_project).toEqual([
      { project_id: '10', project_name: 'Visible-A', hours: 4 },
    ]);
    expect(out.hours_by_project.some((p) => p.project_id === null)).toBe(false);
    // 99 + 88 (3 + 2 hours) collapse into the top-level counts.
    expect(out.out_of_scope_project_count).toBe(2);
    expect(out.out_of_scope_hours).toBe(5);
    expect(typeof out.out_of_scope_project_count).toBe('number');
    expect(typeof out.out_of_scope_hours).toBe('number');
    // Unchanged passthrough fields stay intact.
    expect(out.user.display_name).toBe('Bob');
    expect(out.timeline).toEqual([{ day: '2026-05-15', hours: 9 }]);
    expect(out.exceptions).toEqual([]);
  });

  it('emits zeroed out-of-scope counts and no null-id row when nothing is out of scope', async () => {
    const prisma = makePrismaStub({
      'SELECT id, display_name, email, timezone': [
        { id: 2, display_name: 'Bob', email: 'bob@example.com', timezone: 'Africa/Johannesburg' },
      ],
      'JOIN projects p ON p.id = te.project_id': [
        { project_id: '10', project_name: 'Visible-A', hours: 4 },
        { project_id: '20', project_name: 'Visible-B', hours: 3 },
      ],
      'GROUP BY day': [{ day: '2026-05-15', hours: 7 }],
      'FROM exceptions': [],
    });
    // Both projects are visible.
    const rbac = makeRbacStub({ visibleProjectIds: ['10', '20'], visibleUserIds: ['1', '2'] });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.employeeRollup(actor, '2', '2026-05-01/2026-05-31');
    expect(out.hours_by_project).toEqual([
      { project_id: '10', project_name: 'Visible-A', hours: 4 },
      { project_id: '20', project_name: 'Visible-B', hours: 3 },
    ]);
    expect(out.hours_by_project.some((p) => p.project_id === null)).toBe(false);
    // Present-but-zero, not omitted.
    expect(out).toHaveProperty('out_of_scope_project_count', 0);
    expect(out).toHaveProperty('out_of_scope_hours', 0);
  });
});

describe('project rollup — RBAC + budget calc', () => {
  it('asserts canSeeProject before running queries', async () => {
    const rbac = makeRbacStub({ canSeeProject: false });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makePrismaStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    await expect(
      ctrl.projectRollup(actor, '10', '2026-05-01/2026-05-31'),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('returns budget when hours_budget is set', async () => {
    const prisma = makePrismaStub({
      // Header
      'SELECT p.id, p.name, p.billing_mode': [
        { id: 10, name: 'Proj-A', billing_mode: 'hourly', fixed_fee_amount: null, currency: 'EUR', hours_budget: 100, client_name: 'Acme' },
      ],
      // Total hours
      'COALESCE(SUM(EXTRACT(EPOCH': [{ total_hours: 25, billable_hours: 20 }],
      // Hours by member
      'JOIN users u ON u.id = te.user_id': [{ user_id: '5', display_name: 'Carol', hours: 25 }],
      // Hours by task
      'LEFT JOIN project_tasks': [{ task_id: null, task_name: '(no task)', hours: 25 }],
    });
    const rbac = makeRbacStub({ unrestricted: true });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.projectRollup(admin, '10', '2026-05-01/2026-05-31');
    expect(out.budget).toEqual({
      hours_budget: 100,
      hours_used: 25,
      hours_remaining: 75,
      percent_used: 25,
    });
  });

  it('exposes top-level billable_hours equal to the billable subset of total_hours', async () => {
    const prisma = makePrismaStub({
      'SELECT p.id, p.name, p.billing_mode': [
        { id: 10, name: 'Proj-A', billing_mode: 'hourly', fixed_fee_amount: null, currency: 'EUR', hours_budget: null, client_name: 'Acme' },
      ],
      // total_hours = 25, of which 18 are billable.
      'COALESCE(SUM(EXTRACT(EPOCH': [{ total_hours: 25, billable_hours: 18 }],
      'JOIN users u ON u.id = te.user_id': [{ user_id: '5', display_name: 'Carol', hours: 25 }],
      'LEFT JOIN project_tasks': [{ task_id: null, task_name: '(no task)', hours: 25 }],
    });
    const rbac = makeRbacStub({ unrestricted: true });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.projectRollup(admin, '10', '2026-05-01/2026-05-31');
    expect(out.total_hours).toBe(25);
    expect(out).toHaveProperty('billable_hours', 18);
    expect(typeof out.billable_hours).toBe('number');
  });

  it('returns billable_hours 0 when there are no billable entries', async () => {
    const prisma = makePrismaStub({
      'SELECT p.id, p.name, p.billing_mode': [
        { id: 10, name: 'Proj-A', billing_mode: 'non_billable', fixed_fee_amount: null, currency: 'EUR', hours_budget: null, client_name: 'Acme' },
      ],
      'COALESCE(SUM(EXTRACT(EPOCH': [{ total_hours: 12, billable_hours: 0 }],
      'JOIN users u ON u.id = te.user_id': [{ user_id: '5', display_name: 'Carol', hours: 12 }],
      'LEFT JOIN project_tasks': [{ task_id: null, task_name: '(no task)', hours: 12 }],
    });
    const rbac = makeRbacStub({ unrestricted: true });
    const ctrl = new ReportsController(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rbac as any,
    );
    const out = await ctrl.projectRollup(admin, '10', '2026-05-01/2026-05-31');
    expect(out.billable_hours).toBe(0);
  });
});
