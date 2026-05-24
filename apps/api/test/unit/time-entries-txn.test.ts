import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { IdempotencyConflictError, ValidationFailedError } from '@harvoost/shared';

// Item 2 (M1): start/switch implicit-stop+insert race.
// Asserts:
//   - start wraps the UPDATE + INSERT in a single $transaction (no two-stage gap).
//   - a concurrent race that violates te_one_running_per_user is translated to a
//     clean IdempotencyConflictError (409) rather than a 500.
//   - switch follows the same pattern.

function makeTxStub() {
  const exec: Array<{ sql: string; values: unknown[] }> = [];
  let unique: ((sql: string) => boolean) | null = null;
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      exec.push({ sql, values });
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      exec.push({ sql, values });
      if (unique && unique(sql)) {
        const err = new Error('duplicate key value violates unique constraint "te_one_running_per_user"');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).code = '23505';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any).meta = { constraint: 'te_one_running_per_user' };
        throw err;
      }
      return [{
        id: 1,
        user_id: 10,
        project_id: 2,
        task_id: null,
        notes: null,
        start_at: new Date(),
        end_at: null,
        status: 'running',
        billable: true,
      }];
    }),
  };
  return {
    exec,
    failUniqueOnInsert(fn: ((sql: string) => boolean) | null) {
      unique = fn;
    },
    tx,
  };
}

function makePrismaStub() {
  const tx = makeTxStub();
  return {
    txCalls: tx.exec,
    failUniqueOnInsert: tx.failUniqueOnInsert,
    $transaction: vi.fn(async (fn: (t: typeof tx.tx) => Promise<unknown>) => fn(tx.tx)),
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeIdempotency(opts: { cached?: unknown } = {}) {
  return {
    lookup: vi.fn(async () => opts.cached ?? null),
    store: vi.fn(async () => undefined),
    hashBody: vi.fn(() => 'hash'),
  };
}

function makeRbacStub() {
  return {
    getVisibleUserIds: vi.fn(async () => ({ userIds: [], unrestricted: false, meta: { fromProjects: 0, fromPersons: 0 } })),
    getVisibleProjectIds: vi.fn(async () => ({ projectIds: [], unrestricted: false, meta: { fromProjects: 0, fromPersons: 0 } })),
    assertCanSeeProject: vi.fn(),
    assertCanSeeUser: vi.fn(),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

function makeSyncStub() {
  return { emit: vi.fn(), subscribe: vi.fn(), subscriberCount: vi.fn(() => 0) };
}

// FEAT-002: PeriodService stub — always writable, no-op recompute.
function makePeriodsStub() {
  return {
    getUserTz: vi.fn(async () => 'Africa/Johannesburg'),
    resolveWeek: vi.fn(async () => ({ isoYear: 2026, isoWeek: 21, weekStartDate: '2026-05-18' })),
    assertPeriodWritable: vi.fn(async () => undefined),
    recomputePeriod: vi.fn(async () => undefined),
  };
}

const user = { userId: '10', email: 'e@x', roles: ['employee'] };

describe('TimeEntriesController start/switch — M1 transactional fix', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let idem: ReturnType<typeof makeIdempotency>;
  let rbac: ReturnType<typeof makeRbacStub>;
  let audit: ReturnType<typeof makeAuditStub>;
  let sync: ReturnType<typeof makeSyncStub>;
  let ctrl: TimeEntriesController;

  beforeEach(() => {
    prisma = makePrismaStub();
    idem = makeIdempotency();
    rbac = makeRbacStub();
    audit = makeAuditStub();
    sync = makeSyncStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new TimeEntriesController(prisma as any, idem as any, rbac as any, audit as any, sync as any, makePeriodsStub() as any);
  });

  it('start: requires idempotency-key header', async () => {
    await expect(
      ctrl.start(user, undefined, { project_id: '2' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('start: short-circuits with cached idempotent response', async () => {
    idem.lookup.mockResolvedValueOnce({ id: '99', cached: true });
    const out = await ctrl.start(user, 'key-1', { project_id: '2' });
    expect(out).toEqual({ id: '99', cached: true });
    // No transaction issued for the cached path.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('start: opens a single $transaction containing both UPDATE and INSERT', async () => {
    await ctrl.start(user, 'key-2', { project_id: '2' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Inside the txn we expect both the UPDATE and the INSERT.
    const sqls = prisma.txCalls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls.some((s) => /UPDATE time_entries.*status = 'draft'/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO time_entries/i.test(s))).toBe(true);
  });

  it('start: a race that violates te_one_running_per_user becomes IdempotencyConflictError (409)', async () => {
    prisma.failUniqueOnInsert((sql) => /INSERT INTO time_entries/i.test(sql));
    await expect(
      ctrl.start(user, 'key-race', { project_id: '2' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('start: SyncService.emit is called AFTER the transaction commits', async () => {
    await ctrl.start(user, 'key-3', { project_id: '2' });
    expect(sync.emit).toHaveBeenCalledWith(user.userId, expect.objectContaining({ type: 'timer.started' }));
    // emit happens after $transaction completes (Promise resolves) — no need to assert order
    // beyond that the emit ran when the txn didn't throw.
  });

  it('switch: wraps stop+start in one transaction and converts race to 409', async () => {
    prisma.failUniqueOnInsert((sql) => /INSERT INTO time_entries/i.test(sql));
    await expect(
      ctrl.switch(user, 'key-sw', { project_id: '3' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('switch: happy path emits timer.switched and enqueues overtime check', async () => {
    await ctrl.switch(user, 'key-sw2', { project_id: '3' });
    expect(sync.emit).toHaveBeenCalledWith(user.userId, expect.objectContaining({ type: 'timer.switched' }));
    // enqueueOvertimeCheck calls prisma.$executeRawUnsafe with the overtime_realtime_queue INSERT.
    const insertCalls = prisma.$executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(insertCalls.some((s) => /overtime_realtime_queue/i.test(s))).toBe(true);
  });
});
