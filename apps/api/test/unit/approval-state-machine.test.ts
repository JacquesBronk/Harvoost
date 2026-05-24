import { describe, it, expect, vi } from 'vitest';
import { ApprovalsController } from '../../src/approvals/approvals.controller';
import { ValidationFailedError, RbacForbiddenError } from '@harvoost/shared';

interface MockState {
  // Per-entry stage-1 actor (used by the controller to enforce stage1 != stage2).
  stage1ActorByEntry: Map<string, string>;
  executed: Array<{ sql: string; values: unknown[] }>;
}

function makeController(state: MockState) {
  const prisma = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      state.executed.push({ sql, values });
      if (sql.includes('FROM time_entry_state_history') && sql.includes("to_status = 'manager_approved'")) {
        const entryId = String(values[0]);
        const actor = state.stage1ActorByEntry.get(entryId);
        return actor ? [{ actor_id: actor }] : [];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      state.executed.push({ sql, values });
      return 1;
    }),
  };
  // FEAT-002: PeriodService stub — recompute is a no-op for these per-entry state-machine tests.
  const periods = {
    getUserTz: vi.fn(async () => 'Africa/Johannesburg'),
    resolveWeek: vi.fn(async () => ({ isoYear: 2026, isoWeek: 21, weekStartDate: '2026-05-18' })),
    assertPeriodWritable: vi.fn(async () => undefined),
    recomputePeriod: vi.fn(async () => undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApprovalsController(prisma as any, { record: async () => undefined } as any, periods as any);
}

describe('Approval state machine — manager approve/reject (REQUIREMENTS F6.1)', () => {
  it('manager approve transitions submitted → manager_approved', async () => {
    const state: MockState = { stage1ActorByEntry: new Map(), executed: [] };
    const ctrl = makeController(state);
    const mgr = { userId: 'mgr-1', email: 'm@h.local', roles: ['manager'] };
    await ctrl.managerAction(mgr, { entry_ids: ['100'], action: 'approve' });

    const update = state.executed.find(
      (e) => e.sql.includes('UPDATE time_entries') && e.sql.includes("status = 'submitted'"),
    );
    expect(update).toBeDefined();
    expect(update!.values[0]).toBe('manager_approved');
    const history = state.executed.find((e) => e.sql.includes('INSERT INTO time_entry_state_history'));
    expect(history).toBeDefined();
    expect(history!.values).toContain('manager_approved');
  });

  it('manager reject requires a reason >= 10 chars (REQUIREMENTS F6.1)', async () => {
    const state: MockState = { stage1ActorByEntry: new Map(), executed: [] };
    const ctrl = makeController(state);
    const mgr = { userId: 'mgr-1', email: 'm@h.local', roles: ['manager'] };
    await expect(
      ctrl.managerAction(mgr, { entry_ids: ['100'], action: 'reject', reason: 'short' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      ctrl.managerAction(mgr, { entry_ids: ['100'], action: 'reject' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('manager reject with valid reason transitions to rejected', async () => {
    const state: MockState = { stage1ActorByEntry: new Map(), executed: [] };
    const ctrl = makeController(state);
    const mgr = { userId: 'mgr-1', email: 'm@h.local', roles: ['manager'] };
    await ctrl.managerAction(mgr, {
      entry_ids: ['100'],
      action: 'reject',
      reason: 'this entry was logged against the wrong project, please fix and resubmit',
    });
    const update = state.executed.find((e) => e.sql.includes('UPDATE time_entries'));
    expect(update!.values[0]).toBe('rejected');
  });
});

describe('Approval state machine — final approve/reject (REQUIREMENTS F6.2)', () => {
  it('final approve transitions manager_approved → final_approved', async () => {
    const state: MockState = { stage1ActorByEntry: new Map([['100', 'mgr-1']]), executed: [] };
    const ctrl = makeController(state);
    const finmgr = { userId: 'fin-1', email: 'f@h.local', roles: ['finmgr'] };
    await ctrl.finalAction(finmgr, { entry_ids: ['100'], action: 'approve' });
    const update = state.executed.find(
      (e) => e.sql.includes('UPDATE time_entries') && e.sql.includes("status = 'manager_approved'"),
    );
    expect(update).toBeDefined();
    expect(update!.values[0]).toBe('final_approved');
  });

  it('final reject requires reason >= 10 chars', async () => {
    const state: MockState = { stage1ActorByEntry: new Map([['100', 'mgr-1']]), executed: [] };
    const ctrl = makeController(state);
    const finmgr = { userId: 'fin-1', email: 'f@h.local', roles: ['finmgr'] };
    await expect(
      ctrl.finalAction(finmgr, { entry_ids: ['100'], action: 'reject', reason: 'no' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('Two-stage invariant: stage-1 actor != stage-2 actor (REQUIREMENTS F6.1)', () => {
  it('blocks final approve when stage-1 actor is the same user, even with both roles', async () => {
    const state: MockState = { stage1ActorByEntry: new Map([['100', 'dual-role-user']]), executed: [] };
    const ctrl = makeController(state);
    const dual = { userId: 'dual-role-user', email: 'd@h.local', roles: ['finmgr', 'manager'] };
    await expect(
      ctrl.finalAction(dual, { entry_ids: ['100'], action: 'approve' }),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('allows final approve when a DIFFERENT user holds both roles', async () => {
    const state: MockState = { stage1ActorByEntry: new Map([['100', 'mgr-A']]), executed: [] };
    const ctrl = makeController(state);
    const finOther = { userId: 'fin-B', email: 'f@h.local', roles: ['finmgr'] };
    await ctrl.finalAction(finOther, { entry_ids: ['100'], action: 'approve' });
    const update = state.executed.find((e) => e.sql.includes('UPDATE time_entries'));
    expect(update!.values[0]).toBe('final_approved');
  });

  it('blocks even on a reject — the invariant applies symmetrically', async () => {
    const state: MockState = { stage1ActorByEntry: new Map([['100', 'mgr-X']]), executed: [] };
    const ctrl = makeController(state);
    const sameUser = { userId: 'mgr-X', email: 'x@h.local', roles: ['finmgr'] };
    await expect(
      ctrl.finalAction(sameUser, {
        entry_ids: ['100'],
        action: 'reject',
        reason: 'rejecting because the rate is wrong',
      }),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });
});

describe('Per-entry rejection (REQUIREMENTS F2.2 — partial rejection)', () => {
  it('rejecting a single entry from a batch only affects that entry', async () => {
    const state: MockState = { stage1ActorByEntry: new Map(), executed: [] };
    const ctrl = makeController(state);
    const mgr = { userId: 'mgr-1', email: 'm@h.local', roles: ['manager'] };
    await ctrl.managerAction(mgr, {
      entry_ids: ['100', '101'],
      action: 'reject',
      reason: 'these two entries are mis-coded against project',
    });
    // Two state-history rows should be inserted (one per entry).
    const historyInserts = state.executed.filter((e) =>
      e.sql.includes('INSERT INTO time_entry_state_history'),
    );
    expect(historyInserts).toHaveLength(2);
    expect(historyInserts[0]!.values[0]).toBe('100');
    expect(historyInserts[1]!.values[0]).toBe('101');
  });
});

describe('Admin unlock (REQUIREMENTS F6.3 — final_approved → draft)', () => {
  it('requires a reason >= 20 characters', async () => {
    const state: MockState = { stage1ActorByEntry: new Map(), executed: [] };
    const ctrl = makeController(state);
    const admin = { userId: 'admin', email: 'a@h.local', roles: ['admin'] };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctrl as any).adminUnlock(admin, '100', { reason: 'short' }),
    ).rejects.toThrow();
  });

  it('with valid reason resets to draft and writes history', async () => {
    const state: MockState = { stage1ActorByEntry: new Map(), executed: [] };
    const ctrl = makeController(state);
    const admin = { userId: 'admin', email: 'a@h.local', roles: ['admin'] };
    await ctrl.adminUnlock(admin, '100', {
      reason: 'correcting time logged against wrong project — needs re-coding',
    });
    const update = state.executed.find((e) => e.sql.includes('UPDATE time_entries'));
    expect(update).toBeDefined();
    const history = state.executed.find((e) =>
      e.sql.includes('INSERT INTO time_entry_state_history'),
    );
    expect(history).toBeDefined();
    // Reason captured.
    expect(history!.values).toContain('correcting time logged against wrong project — needs re-coding');
  });
});
