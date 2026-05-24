import { describe, it, expect, vi } from 'vitest';
import { ApprovalsController } from '../../src/approvals/approvals.controller';
import { PeriodService } from '../../src/timesheet-periods/period.service';
import { RbacForbiddenError } from '@harvoost/shared';
import type { CurrentUserPayload } from '../../src/common/current-user.decorator';

// FEAT-002 (issue #6) — the ENRICHED, RBAC-scoped, per-(user, ISO-week) approvals queue.
// The handler builds a single grouped SQL; we capture it and return synthetic grouped rows so
// we can assert (a) the shape, (b) the status the WHERE filters on (stage), (c) the RBAC scope
// clause / userIds bound, and (d) total_hours pass-through + rounding.

interface GroupedRow {
  period_id: unknown;
  user_id: unknown;
  user_name: unknown;
  iso_year: unknown;
  iso_week: unknown;
  total_hours: unknown;
  submitted_at: unknown;
}

function makePrisma(groupedRows: GroupedRow[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const stub = {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      // The enriched queue query is the only $queryRawUnsafe the handler issues directly.
      if (sql.includes('WITH grouped AS') && sql.includes('FROM time_entries te')) {
        return groupedRows;
      }
      // RbacScopeService.canActAsRole role lookup (when rbac is the REAL service) — not used here
      // because we inject a stub rbac. Default empty.
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
  return stub;
}

// RBAC stub: returns a fixed visible set; unrestricted toggles admin/finmgr short-circuit.
function makeRbac(opts: { userIds?: string[]; unrestricted?: boolean; denyUser?: string } = {}) {
  return {
    getVisibleUserIds: vi.fn(async () => ({
      userIds: opts.userIds ?? ['3'],
      meta: { fromProjects: 0, fromPersons: 0 },
      unrestricted: opts.unrestricted ?? false,
    })),
    assertCanSeeUser: vi.fn(async (_requester: string, target: string) => {
      if (opts.denyUser && target === opts.denyUser) throw new RbacForbiddenError();
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeController(prisma: ReturnType<typeof makePrisma>, rbac: ReturnType<typeof makeRbac>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periods = new PeriodService(prisma as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApprovalsController(prisma as any, { record: async () => undefined } as any, periods, rbac);
}

const manager: CurrentUserPayload = { userId: '10', email: 'm@h.local', roles: ['manager'] };
const finmgr: CurrentUserPayload = { userId: '20', email: 'f@h.local', roles: ['finmgr'] };
const admin: CurrentUserPayload = { userId: '1', email: 'a@h.local', roles: ['admin'] };
const employee: CurrentUserPayload = { userId: '3', email: 'e@h.local', roles: ['employee'] };

function row(over: Partial<GroupedRow> = {}): GroupedRow {
  return {
    period_id: '7',
    user_id: '3',
    user_name: 'Bob Builder',
    iso_year: 2026,
    iso_week: 21,
    total_hours: 38.5,
    submitted_at: new Date('2026-05-22T16:00:00Z'),
    ...over,
  };
}

describe('GET /v1/approvals/queue — enriched grouped shape', () => {
  it('returns enriched per-(user, ISO-week) items, not raw entry rows', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    expect(out.data).toHaveLength(1);
    const item = out.data[0]!;
    expect(item).toEqual({
      id: '7',
      user_id: '3',
      user_name: 'Bob Builder',
      iso_week: '2026-W21',
      total_hours: 38.5,
      status: 'submitted',
      submitted_at: '2026-05-22T16:00:00.000Z',
    });
    // No raw per-entry fields leak through.
    expect(item).not.toHaveProperty('project_id');
    expect(item).not.toHaveProperty('start_at');
    expect(item).not.toHaveProperty('end_at');
  });

  it('falls back to a stable composite id when no timesheet_periods row exists', async () => {
    const prisma = makePrisma([row({ period_id: null })]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    expect(out.data[0]!.id).toBe('3-2026-21');
  });

  it('zero-pads the ISO week to YYYY-Www', async () => {
    const prisma = makePrisma([row({ iso_week: 5 })]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    expect(out.data[0]!.iso_week).toBe('2026-W05');
  });

  it('rounds total_hours to 2 decimals', async () => {
    const prisma = makePrisma([row({ total_hours: 7.123456 })]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    expect(out.data[0]!.total_hours).toBe(7.12);
  });
});

describe('GET /v1/approvals/queue — stage drives the status filter', () => {
  it('stage=manager filters on submitted entries', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    expect(out.data[0]!.status).toBe('submitted');
    const queueCall = prisma.calls.find((c) => /WITH grouped AS/.test(c.sql));
    expect(queueCall!.values[0]).toBe('submitted'); // $1 bound status
  });

  it('stage=final filters on manager_approved entries (finmgr)', async () => {
    const prisma = makePrisma([row({ submitted_at: new Date('2026-05-23T09:00:00Z') })]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'], unrestricted: true }));
    const out = await ctrl.queue(finmgr, { stage: 'final', limit: 50 });
    expect(out.data[0]!.status).toBe('manager_approved');
    const queueCall = prisma.calls.find((c) => /WITH grouped AS/.test(c.sql));
    expect(queueCall!.values[0]).toBe('manager_approved');
  });

  it('infers stage from roles when ?stage is absent (manager → submitted)', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { limit: 50 });
    expect(out.data[0]!.status).toBe('submitted');
  });

  it('infers stage from roles when ?stage is absent (finmgr → manager_approved)', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ unrestricted: true }));
    const out = await ctrl.queue(finmgr, { limit: 50 });
    expect(out.data[0]!.status).toBe('manager_approved');
  });

  it('a manager cannot peek the FINAL (stage-2) queue → empty', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(manager, { stage: 'final', limit: 50 });
    expect(out.data).toEqual([]);
    // No grouped query should even be issued.
    expect(prisma.calls.find((c) => /WITH grouped AS/.test(c.sql))).toBeUndefined();
  });

  it('a finmgr cannot peek the MANAGER (stage-1) queue → empty', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ unrestricted: true }));
    const out = await ctrl.queue(finmgr, { stage: 'manager', limit: 50 });
    expect(out.data).toEqual([]);
  });

  it('a plain employee gets an empty queue (no approval capability)', async () => {
    const prisma = makePrisma([row()]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3'] }));
    const out = await ctrl.queue(employee, { limit: 50 });
    expect(out.data).toEqual([]);
  });
});

describe('GET /v1/approvals/queue — RBAC scoping', () => {
  it('a manager is scoped to their visible users (ANY($n::bigint[]) clause + bound ids)', async () => {
    const prisma = makePrisma([row()]);
    const rbac = makeRbac({ userIds: ['3', '4'], unrestricted: false });
    const ctrl = makeController(prisma, rbac);
    await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    expect(rbac.getVisibleUserIds).toHaveBeenCalledWith('10');
    const queueCall = prisma.calls.find((c) => /WITH grouped AS/.test(c.sql));
    expect(queueCall!.sql).toMatch(/te\.user_id = ANY\(\$2::bigint\[\]\)/);
    expect(queueCall!.values[1]).toEqual(['3', '4']); // the visible-users array is bound
  });

  it('admin/finmgr (unrestricted) skip the IN-filter (no ANY clause, sees all groups)', async () => {
    const prisma = makePrisma([row(), row({ user_id: '99', user_name: 'Other', period_id: '8' })]);
    const ctrl = makeController(prisma, makeRbac({ unrestricted: true }));
    const out = await ctrl.queue(admin, { stage: 'manager', limit: 50 });
    expect(out.data).toHaveLength(2);
    const queueCall = prisma.calls.find((c) => /WITH grouped AS/.test(c.sql));
    expect(queueCall!.sql).not.toMatch(/te\.user_id = ANY/);
  });

  it('explicit ?user_id passes through assertCanSeeUser and binds the user filter', async () => {
    const prisma = makePrisma([row()]);
    const rbac = makeRbac({ userIds: ['3'], unrestricted: false });
    const ctrl = makeController(prisma, rbac);
    await ctrl.queue(manager, { stage: 'manager', user_id: '3', limit: 50 });
    expect(rbac.assertCanSeeUser).toHaveBeenCalledWith('10', '3');
    const queueCall = prisma.calls.find((c) => /WITH grouped AS/.test(c.sql));
    expect(queueCall!.sql).toMatch(/te\.user_id = \$3::bigint/);
  });

  it('explicit ?user_id for an out-of-scope user is rejected (403)', async () => {
    const prisma = makePrisma([row()]);
    const rbac = makeRbac({ userIds: ['3'], unrestricted: false, denyUser: '999' });
    const ctrl = makeController(prisma, rbac);
    await expect(
      ctrl.queue(manager, { stage: 'manager', user_id: '999', limit: 50 }),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });
});

describe('GET /v1/approvals/queue — total_hours summation (group-level)', () => {
  it('passes the grouped SUM through as total_hours (the DB sums the durations)', async () => {
    // Two distinct groups: Bob W21 = 38.5h, Carol W20 = 12.25h.
    const prisma = makePrisma([
      row({ user_id: '3', user_name: 'Bob', iso_week: 21, total_hours: 38.5, period_id: '7' }),
      row({ user_id: '4', user_name: 'Carol', iso_week: 20, total_hours: 12.25, period_id: null }),
    ]);
    const ctrl = makeController(prisma, makeRbac({ userIds: ['3', '4'] }));
    const out = await ctrl.queue(manager, { stage: 'manager', limit: 50 });
    const bob = out.data.find((d) => d.user_id === '3')!;
    const carol = out.data.find((d) => d.user_id === '4')!;
    expect(bob.total_hours).toBe(38.5);
    expect(carol.total_hours).toBe(12.25);
    expect(carol.id).toBe('4-2026-20');
    // The grouped query sums EPOCH duration / 3600 — assert the SUM expression is present.
    const queueCall = prisma.calls.find((c) => /WITH grouped AS/.test(c.sql));
    expect(queueCall!.sql).toMatch(/SUM\(EXTRACT\(EPOCH FROM \(te\.end_at - te\.start_at\)\) \/ 3600\.0\)/);
  });
});
