import { describe, it, expect, vi } from 'vitest';
import { ApprovalsController } from '../../src/approvals/approvals.controller';
import { RbacForbiddenError } from '@harvoost/shared';

// We construct the controller with a tiny in-memory Prisma stub and assert the invariant:
// the same user cannot perform both stage-1 (manager_approved) and stage-2 (final_approved)
// on the same entry.
function makeController(stage1Actor: string) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const prisma = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('FROM time_entry_state_history') && sql.includes("to_status = 'manager_approved'")) {
        return [{ actor_id: stage1Actor }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
  // FEAT-002: PeriodService stub — recompute is a no-op for the two-stage invariant tests.
  const periods = {
    getUserTz: vi.fn(async () => 'Africa/Johannesburg'),
    resolveWeek: vi.fn(async () => ({ isoYear: 2026, isoWeek: 21, weekStartDate: '2026-05-18' })),
    assertPeriodWritable: vi.fn(async () => undefined),
    recomputePeriod: vi.fn(async () => undefined),
  };
  // FEAT-002 expansion: queue() needs RbacScopeService; the transitions here don't use it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rbac = { getVisibleUserIds: async () => ({ userIds: [], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true }), assertCanSeeUser: async () => undefined } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApprovalsController(prisma as any, { record: async () => undefined } as any, periods as any, rbac);
}

describe('Two-stage approval invariant', () => {
  it('rejects stage-2 when actor was also stage-1', async () => {
    const ctrl = makeController('user-A');
    await expect(
      ctrl.finalAction(
        { userId: 'user-A', email: 'a@h.local', roles: ['finmgr', 'manager'] },
        { entry_ids: ['100'], action: 'approve' },
      ),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('allows stage-2 by a different actor than stage-1', async () => {
    const ctrl = makeController('user-A');
    await expect(
      ctrl.finalAction(
        { userId: 'user-B', email: 'b@h.local', roles: ['finmgr'] },
        { entry_ids: ['100'], action: 'approve' },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects reject-without-reason at stage 2', async () => {
    const ctrl = makeController('user-A');
    await expect(
      ctrl.finalAction(
        { userId: 'user-B', email: 'b@h.local', roles: ['finmgr'] },
        { entry_ids: ['100'], action: 'reject' },
      ),
    ).rejects.toThrow(/at least 10 characters/i);
  });
});
