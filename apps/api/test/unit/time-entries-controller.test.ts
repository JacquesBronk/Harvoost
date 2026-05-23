import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { ValidationFailedError, EntryLockedError, NotFoundError } from '@harvoost/shared';
import type { RbacScopeService } from '@harvoost/shared';

// Lightweight Prisma stub.
function makePrisma() {
  const store: Map<string, { body_hash: string; response: unknown }> = new Map();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    calls,
    store,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT body_hash, response FROM idempotency_keys')) {
        const key = `${String(values[0])}:${String(values[1])}`;
        const v = store.get(key);
        return v ? [v] : [];
      }
      // INSERT INTO time_entries ... RETURNING ...
      if (sql.includes('INSERT INTO time_entries')) {
        return [
          {
            id: '1',
            user_id: String(values[0]),
            project_id: String(values[1]),
            task_id: null,
            notes: null,
            start_at: new Date('2026-05-22T08:00:00Z'),
            end_at: null,
            status: 'running',
            billable: true,
            mood_score: null,
            cost_rate: 350,
            cost_amount: 0,
            billable_rate: 1100,
            billable_amount: 0,
          },
        ];
      }
      // UPDATE ... RETURNING ...
      if (sql.includes('UPDATE time_entries') && sql.includes('RETURNING')) {
        return [
          {
            id: '1',
            user_id: String(values[0]),
            project_id: '1',
            task_id: null,
            notes: null,
            start_at: new Date('2026-05-22T08:00:00Z'),
            end_at: new Date('2026-05-22T09:00:00Z'),
            status: 'draft',
            billable: true,
            cost_rate: 350,
            cost_amount: 350,
          },
        ];
      }
      // SELECT FROM time_entries WHERE id = ... (edit/delete check)
      if (sql.includes('SELECT status, user_id FROM time_entries')) {
        return [{ status: 'draft', user_id: '101' }];
      }
      // Overlap pre-check returns empty by default.
      return [];
    }) as unknown as (sql: string, ...values: unknown[]) => Promise<unknown>,
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('INSERT INTO idempotency_keys')) {
        const key = `${String(values[0])}:${String(values[1])}`;
        if (!store.has(key)) {
          store.set(key, { body_hash: String(values[2]), response: JSON.parse(String(values[3])) });
        }
        return 1;
      }
      if (sql.includes('CREATE TABLE')) return 0;
      return 1;
    }) as unknown as (sql: string, ...values: unknown[]) => Promise<number>,
  };
  // M1 fix: start/switch wrap their SQL in $transaction. The tx callback receives
  // a Prisma-shaped object; we proxy to the same stub so the existing calls[] log
  // observes every SQL statement.
  stub.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stub));
  return stub;
}

function makeRbac(): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: ['101'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
    getVisibleProjectIds: async () => ({ projectIds: ['1'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
  } as unknown as RbacScopeService;
}

describe('POST /v1/time-entries/start — idempotency header enforcement', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ctrl: TimeEntriesController;
  beforeEach(() => {
    prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idem = new IdempotencyService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new TimeEntriesController(prisma as any, idem, makeRbac(), { record: async () => undefined } as any, { emit: () => {}, subscribe: () => ({ subject: {}, unsubscribe: () => {} }), subscriberCount: () => 0 } as any);
  });
  const employee = { userId: '101', email: 'e@h.local', roles: ['employee'] };

  it('throws VALIDATION_FAILED 400 when Idempotency-Key header is missing on start', async () => {
    await expect(ctrl.start(employee, undefined, { project_id: '1' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('throws VALIDATION_FAILED on stop when header is missing', async () => {
    await expect(ctrl.stop(employee, undefined, {})).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('throws VALIDATION_FAILED on switch when header is missing', async () => {
    await expect(
      ctrl.switch(employee, undefined, { project_id: '1' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('with a header, succeeds and returns a normalized row', async () => {
    const out = await ctrl.start(employee, 'idem-key-1', { project_id: '1' });
    expect(out).toMatchObject({ id: '1', status: 'running' });
  });

  it('replays the SAME response on a same-key, same-body retry (idempotent)', async () => {
    const first = await ctrl.start(employee, 'idem-key-2', { project_id: '1' });
    const second = await ctrl.start(employee, 'idem-key-2', { project_id: '1' });
    expect(second).toEqual(first);
  });
});

describe('Cost-column stripping for non-financial roles (API_NOTES § Cost-column stripping)', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ctrl: TimeEntriesController;
  beforeEach(() => {
    prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idem = new IdempotencyService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new TimeEntriesController(prisma as any, idem, makeRbac(), { record: async () => undefined } as any, { emit: () => {}, subscribe: () => ({ subject: {}, unsubscribe: () => {} }), subscriberCount: () => 0 } as any);
  });

  it('Employee role: response from start() OMITS cost_rate, cost_amount entirely (not null)', async () => {
    const employee = { userId: '101', email: 'e@h.local', roles: ['employee'] };
    const out = await ctrl.start(employee, 'idem-A', { project_id: '1' });
    expect(out).not.toHaveProperty('cost_rate');
    expect(out).not.toHaveProperty('cost_amount');
    expect(out).not.toHaveProperty('billable_rate');
    expect(out).not.toHaveProperty('billable_amount');
  });

  it('Manager role: response also OMITS financial fields (Manager is non-financial per RBAC matrix)', async () => {
    const mgr = { userId: '102', email: 'm@h.local', roles: ['manager'] };
    const out = await ctrl.start(mgr, 'idem-B', { project_id: '1' });
    expect(out).not.toHaveProperty('cost_rate');
    expect(out).not.toHaveProperty('cost_amount');
  });

  it('FinMgr role: response INCLUDES cost_rate and cost_amount', async () => {
    const fin = { userId: '999', email: 'f@h.local', roles: ['finmgr'] };
    const out = await ctrl.start(fin, 'idem-C', { project_id: '1' });
    expect(out).toHaveProperty('cost_rate');
    expect(out).toHaveProperty('cost_amount');
  });

  it('Admin role: response INCLUDES cost_rate and cost_amount', async () => {
    const admin = { userId: '999', email: 'a@h.local', roles: ['admin'] };
    const out = await ctrl.start(admin, 'idem-D', { project_id: '1' });
    expect(out).toHaveProperty('cost_rate');
  });
});

describe('Manual time-entry create — overlap detection (REQUIREMENTS F2.1)', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ctrl: TimeEntriesController;
  beforeEach(() => {
    prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idem = new IdempotencyService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new TimeEntriesController(prisma as any, idem, makeRbac(), { record: async () => undefined } as any, { emit: () => {}, subscribe: () => ({ subject: {}, unsubscribe: () => {} }), subscriberCount: () => 0 } as any);
  });
  const employee = { userId: '101', email: 'e@h.local', roles: ['employee'] };

  it('rejects entries where end_at <= start_at with VALIDATION_FAILED', async () => {
    await expect(
      ctrl.createManual(employee, {
        project_id: '1',
        start_at: '2026-05-22T10:00:00Z',
        end_at: '2026-05-22T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects entries longer than 24 hours', async () => {
    await expect(
      ctrl.createManual(employee, {
        project_id: '1',
        start_at: '2026-05-22T08:00:00Z',
        end_at: '2026-05-23T09:00:00Z', // 25h
      }),
    ).rejects.toThrow(/24 hours/i);
  });

  it('rejects an overlapping entry when the GIST pre-check returns a row', async () => {
    // Wire the pre-check to find an overlap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$queryRawUnsafe.mockImplementationOnce(async (sql: string) => {
      if (sql.includes('tstzrange')) return [{ id: '99' }];
      return [];
    });
    await expect(
      ctrl.createManual(employee, {
        project_id: '1',
        start_at: '2026-05-22T08:00:00Z',
        end_at: '2026-05-22T09:00:00Z',
      }),
    ).rejects.toThrow(/overlapping/i);
  });

  it('allows an overnight shift (22:00 → 02:00 next day, 4h total)', async () => {
    const out = await ctrl.createManual(employee, {
      project_id: '1',
      start_at: '2026-05-22T20:00:00Z',
      end_at: '2026-05-23T00:00:00Z',
    });
    expect(out).toMatchObject({ id: '1' });
  });
});

describe('Edit blocked when entry is locked (REQUIREMENTS F2.1 — submitted/manager_approved/final_approved)', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ctrl: TimeEntriesController;
  const employee = { userId: '101', email: 'e@h.local', roles: ['employee'] };

  beforeEach(() => {
    prisma = makePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idem = new IdempotencyService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new TimeEntriesController(prisma as any, idem, makeRbac(), { record: async () => undefined } as any, { emit: () => {}, subscribe: () => ({ subject: {}, unsubscribe: () => {} }), subscriberCount: () => 0 } as any);
  });

  it.each(['submitted', 'manager_approved', 'final_approved'])(
    'rejects PATCH on a %s entry with ENTRY_LOCKED 409',
    async (status) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).$queryRawUnsafe.mockImplementationOnce(async () => [{ status, user_id: '101' }]);
      await expect(ctrl.edit(employee, '42', { notes: 'updated' })).rejects.toBeInstanceOf(
        EntryLockedError,
      );
    },
  );

  it('allows PATCH on a draft entry', async () => {
    // First call: existing-row lookup returns draft.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$queryRawUnsafe.mockImplementationOnce(async () => [{ status: 'draft', user_id: '101' }]);
    const out = await ctrl.edit(employee, '42', { notes: 'updated' });
    expect(out).toEqual({ ok: true });
  });

  it('returns 404 uniform when editing another user`s entry (no existence leak)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$queryRawUnsafe.mockImplementationOnce(async () => [{ status: 'draft', user_id: '999' }]);
    await expect(ctrl.edit(employee, '42', { notes: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(['submitted', 'manager_approved', 'final_approved'])(
    'rejects DELETE on a %s entry with ENTRY_LOCKED 409',
    async (status) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).$queryRawUnsafe.mockImplementationOnce(async () => [{ status, user_id: '101' }]);
      await expect(ctrl.remove(employee, '42')).rejects.toBeInstanceOf(EntryLockedError);
    },
  );
});
