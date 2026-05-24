import { describe, it, expect, vi } from 'vitest';
import { ApprovalsController } from '../../src/approvals/approvals.controller';
import { PeriodService } from '../../src/timesheet-periods/period.service';
import { RbacForbiddenError } from '@harvoost/shared';

// FEAT-002 (issue #6) — the approvals controller recomputes the affected period inside each
// transition handler (manager/final/admin-unlock) WITHOUT changing the approval contract, and
// preserves the stage1 != stage2 invariant (a failed final transition does NOT recompute).

const TZ = 'Africa/Johannesburg';

function makePrisma(opts: { stage1Actor?: string; counts?: Record<string, number> } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const stub = {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT timezone FROM users')) return [{ timezone: TZ }];
      if (sql.includes('EXTRACT(ISOYEAR FROM') && sql.includes('AS iso_year')) {
        return [{ iso_year: 2026, iso_week: 21, week_start: '2026-05-18' }];
      }
      if (sql.includes('SELECT user_id, start_at FROM time_entries')) {
        return [{ user_id: '3', start_at: '2026-05-20T08:00:00Z' }];
      }
      if (sql.includes('FROM time_entry_state_history') && sql.includes("to_status = 'manager_approved'")) {
        return opts.stage1Actor ? [{ actor_id: opts.stage1Actor }] : [];
      }
      if (sql.includes('COUNT(*)::int AS n') && sql.includes('GROUP BY status')) {
        const counts = opts.counts ?? {};
        return Object.entries(counts).map(([status, n]) => ({ status, n }));
      }
      if (sql.includes('SELECT status FROM timesheet_periods')) {
        return [{ status: 'submitted' }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return 1;
    }),
  };
  return stub;
}

function makeController(prisma: ReturnType<typeof makePrisma>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periods = new PeriodService(prisma as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApprovalsController(prisma as any, { record: async () => undefined } as any, periods);
}

describe('managerAction recompute hook', () => {
  it('recomputes the affected period after approving (period follows entries → manager_approved)', async () => {
    const prisma = makePrisma({ counts: { manager_approved: 3 } });
    const ctrl = makeController(prisma);
    await ctrl.managerAction(
      { userId: 'mgr-1', email: 'm@h', roles: ['manager'] },
      { entry_ids: ['100'], action: 'approve' },
    );
    const periodWrite = prisma.calls.find((c) => /UPDATE timesheet_periods SET/.test(c.sql));
    expect(periodWrite).toBeDefined();
    expect(String(periodWrite!.values[3])).toBe('manager_approved');
  });

  it('recomputes to rejected after a manager reject', async () => {
    const prisma = makePrisma({ counts: { rejected: 1, submitted: 2 } });
    const ctrl = makeController(prisma);
    await ctrl.managerAction(
      { userId: 'mgr-1', email: 'm@h', roles: ['manager'] },
      { entry_ids: ['100'], action: 'reject', reason: 'wrong project coding, please redo' },
    );
    const periodWrite = prisma.calls.find((c) => /UPDATE timesheet_periods SET/.test(c.sql));
    expect(String(periodWrite!.values[3])).toBe('rejected');
  });
});

describe('finalAction recompute hook + stage1 != stage2 preserved', () => {
  it('recomputes to final_approved when a different actor finalizes', async () => {
    const prisma = makePrisma({ stage1Actor: 'mgr-A', counts: { final_approved: 2 } });
    const ctrl = makeController(prisma);
    await ctrl.finalAction(
      { userId: 'fin-B', email: 'f@h', roles: ['finmgr'] },
      { entry_ids: ['100'], action: 'approve' },
    );
    const periodWrite = prisma.calls.find((c) => /UPDATE timesheet_periods SET/.test(c.sql));
    expect(String(periodWrite!.values[3])).toBe('final_approved');
  });

  it('does NOT recompute when the stage1 == stage2 invariant blocks the transition', async () => {
    const prisma = makePrisma({ stage1Actor: 'dual-user', counts: { manager_approved: 1 } });
    const ctrl = makeController(prisma);
    await expect(
      ctrl.finalAction(
        { userId: 'dual-user', email: 'd@h', roles: ['finmgr', 'manager'] },
        { entry_ids: ['100'], action: 'approve' },
      ),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
    // The recompute runs only AFTER the loop; a mid-loop throw must skip it.
    const periodWrite = prisma.calls.find((c) => /UPDATE timesheet_periods SET|INSERT INTO timesheet_periods/.test(c.sql));
    expect(periodWrite).toBeUndefined();
  });
});

describe('adminUnlock recompute hook (D4 reopen)', () => {
  it('recomputes the period to open with reopened_at after unlocking an entry', async () => {
    const prisma = makePrisma({ counts: { draft: 1, final_approved: 2 } });
    // Existing period is locked (final_approved) so dropping below submitted → reopen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$queryRawUnsafe.mockImplementation(async (sql: string, ...values: unknown[]) => {
      prisma.calls.push({ sql, values });
      if (sql.includes('SELECT timezone FROM users')) return [{ timezone: TZ }];
      if (sql.includes('EXTRACT(ISOYEAR FROM') && sql.includes('AS iso_year')) {
        return [{ iso_year: 2026, iso_week: 21, week_start: '2026-05-18' }];
      }
      if (sql.includes('SELECT user_id, start_at FROM time_entries')) {
        return [{ user_id: '3', start_at: '2026-05-20T08:00:00Z' }];
      }
      if (sql.includes('COUNT(*)::int AS n') && sql.includes('GROUP BY status')) {
        return [{ status: 'draft', n: 1 }, { status: 'final_approved', n: 2 }];
      }
      if (sql.includes('SELECT status FROM timesheet_periods')) {
        return [{ status: 'final_approved' }];
      }
      return [];
    });
    const ctrl = makeController(prisma);
    await ctrl.adminUnlock(
      { userId: 'admin', email: 'a@h', roles: ['admin'] },
      '100',
      { reason: 'reopening an over-approved week to correct a mis-coded entry' },
    );
    const periodWrite = prisma.calls.find((c) => /UPDATE timesheet_periods SET/.test(c.sql));
    expect(periodWrite).toBeDefined();
    expect(String(periodWrite!.values[3])).toBe('open');
    expect(periodWrite!.values[4]).toBe(true); // reopened flag
  });
});
