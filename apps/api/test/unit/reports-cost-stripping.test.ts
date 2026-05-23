import { describe, it, expect, vi } from 'vitest';
import { ReportsController } from '../../src/reports/reports.controller';
import type { RbacScopeService } from '@harvoost/shared';

function makePrisma() {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM time_entries')) {
        // Return rows carrying cost_rate + cost_amount fields (as a row from a financial query).
        // Note: the SELECT in reports.controller.ts doesn't include these by default; we patch
        // the response shape here to test the STRIPPER's defence-in-depth behavior — if a future
        // SELECT change inadvertently includes cost fields, the stripper still removes them.
        return [
          {
            id: '1',
            user_id: '101',
            project_id: '1',
            start_at: new Date('2026-05-22T08:00:00Z'),
            end_at: new Date('2026-05-22T17:00:00Z'),
            notes: null,
            billable: true,
            cost_rate: 350,
            cost_amount: 3150,
            billable_rate: 1100,
            billable_amount: 9900,
          },
        ];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbac(): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: ['101'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true }),
    getVisibleProjectIds: async () => ({ projectIds: ['1'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true }),
  } as unknown as RbacScopeService;
}

describe('POST /v1/reports/detailed-activity — cost-column stripping (REQUIREMENTS F9.1, API_NOTES)', () => {
  it('Employee role: rows DO NOT include cost_rate or cost_amount', async () => {
    const prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ReportsController(prisma as any, makeRbac());
    const employee = { userId: '101', email: 'e@h.local', roles: ['employee'] };
    const out = await ctrl.detailedActivity(employee, {
      date_from: '2026-05-01',
      date_to: '2026-05-31',
      limit: 50,
    });
    expect(out.data).toHaveLength(1);
    const row = out.data[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('cost_rate');
    expect(row).not.toHaveProperty('cost_amount');
    expect(row).not.toHaveProperty('billable_rate');
    expect(row).not.toHaveProperty('billable_amount');
  });

  it('Manager role: rows DO NOT include cost_rate or cost_amount (Manager is non-financial)', async () => {
    const prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ReportsController(prisma as any, makeRbac());
    const mgr = { userId: '101', email: 'm@h.local', roles: ['manager'] };
    const out = await ctrl.detailedActivity(mgr, {
      date_from: '2026-05-01',
      date_to: '2026-05-31',
      limit: 50,
    });
    const row = out.data[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('cost_rate');
    expect(row).not.toHaveProperty('cost_amount');
  });

  it('FinMgr role: rows INCLUDE cost_rate and cost_amount', async () => {
    const prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ReportsController(prisma as any, makeRbac());
    const fin = { userId: '999', email: 'f@h.local', roles: ['finmgr'] };
    const out = await ctrl.detailedActivity(fin, {
      date_from: '2026-05-01',
      date_to: '2026-05-31',
      limit: 50,
    });
    const row = out.data[0] as Record<string, unknown>;
    expect(row).toHaveProperty('cost_rate');
    expect(row).toHaveProperty('cost_amount');
    expect(row.cost_rate).toBe(350);
    expect(row.cost_amount).toBe(3150);
  });

  it('Admin role: rows INCLUDE cost_rate and cost_amount', async () => {
    const prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ReportsController(prisma as any, makeRbac());
    const admin = { userId: '999', email: 'a@h.local', roles: ['admin'] };
    const out = await ctrl.detailedActivity(admin, {
      date_from: '2026-05-01',
      date_to: '2026-05-31',
      limit: 50,
    });
    expect(out.data[0]).toHaveProperty('cost_rate');
  });

  it('Stripped fields are ABSENT, not null-zeroed (API_NOTES § Cost-column stripping)', async () => {
    const prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ReportsController(prisma as any, makeRbac());
    const mgr = { userId: '101', email: 'm@h.local', roles: ['manager'] };
    const out = await ctrl.detailedActivity(mgr, {
      date_from: '2026-05-01',
      date_to: '2026-05-31',
      limit: 50,
    });
    const row = out.data[0] as Record<string, unknown>;
    // Specifically: cost_rate is NOT present with value null/0; it's absent entirely.
    const keys = Object.keys(row);
    expect(keys).not.toContain('cost_rate');
    expect(keys).not.toContain('cost_amount');
  });
});
