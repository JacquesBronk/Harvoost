import { describe, it, expect, vi } from 'vitest';
import { TimesheetPeriodsController } from '../../src/timesheet-periods/timesheet-periods.controller';
import { PeriodService } from '../../src/timesheet-periods/period.service';
import { ValidationFailedError } from '@harvoost/shared';
import type { RbacScopeService } from '@harvoost/shared';

// FEAT-002 (issue #6) — the read endpoint + the admin unlock-week convenience.

const OWNER = '3';
const TZ = 'Africa/Johannesburg';

function makePrisma(opts: {
  periodRow?: Record<string, unknown> | null;
  counts?: Record<string, number>;
  lockedEntries?: Array<{ id: string; status: string }>;
  isoYear?: number;
  isoWeek?: number;
} = {}) {
  const isoYear = opts.isoYear ?? 2026;
  const isoWeek = opts.isoWeek ?? 21;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const stub: Record<string, unknown> = {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT timezone FROM users')) return [{ timezone: TZ }];
      if (sql.includes('EXTRACT(ISOYEAR FROM') && sql.includes('AS iso_year')) {
        return [{ iso_year: isoYear, iso_week: isoWeek, week_start: '2026-05-18' }];
      }
      // single GET / list period rows
      if (sql.includes('FROM timesheet_periods') && sql.includes('week_start_date')) {
        return opts.periodRow ? [opts.periodRow] : [];
      }
      if (sql.includes('SELECT status FROM timesheet_periods')) {
        return opts.periodRow ? [{ status: String(opts.periodRow.status) }] : [];
      }
      // entry_counts / recompute GROUP BY
      if (sql.includes('COUNT(*)::int AS n') && sql.includes('GROUP BY status')) {
        const counts = opts.counts ?? {};
        return Object.entries(counts).map(([status, n]) => ({ status, n }));
      }
      // unlock-week: locked entries in the week
      if (sql.includes('FROM time_entries') && sql.includes("status IN ('submitted','manager_approved','final_approved')")) {
        return opts.lockedEntries ?? [];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return 1;
    }),
  };
  stub.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stub));
  return stub;
}

function makeRbac(unrestricted = false): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: [OWNER], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted }),
    getVisibleProjectIds: async () => ({ projectIds: ['1'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted }),
    assertCanSeeUser: async () => undefined,
    assertCanSeeProject: async () => undefined,
  } as unknown as RbacScopeService;
}

const noopAudit = { record: vi.fn(async () => undefined) };

function makeController(prisma: ReturnType<typeof makePrisma>, rbac = makeRbac()): TimesheetPeriodsController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periods = new PeriodService(prisma as any);
  return new TimesheetPeriodsController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    periods,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    noopAudit as any,
    rbac,
  );
}

const owner = { userId: OWNER, email: 'o@h.local', roles: ['employee'] };
const admin = { userId: '1', email: 'a@h.local', roles: ['admin'] };

describe('GET /v1/timesheet-periods/{iso_week}', () => {
  it('rejects a malformed iso_week', async () => {
    const ctrl = makeController(makePrisma());
    await expect(ctrl.getOne(owner, '2026-21')).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('returns a synthesized open shell when no row exists', async () => {
    const prisma = makePrisma({ periodRow: null, counts: { draft: 2 } });
    const ctrl = makeController(prisma);
    const out = await ctrl.getOne(owner, '2026-W21');
    expect(out).toMatchObject({ status: 'open', iso_year: 2026, iso_week: 21 });
    expect(out.entry_counts).toMatchObject({ draft: 2 });
  });

  it('returns the persisted row + entry_counts when a row exists', async () => {
    const prisma = makePrisma({
      periodRow: {
        id: '7',
        user_id: OWNER,
        iso_year: 2026,
        iso_week: 21,
        week_start_date: '2026-05-18',
        status: 'submitted',
        submitted_at: new Date('2026-05-20T10:00:00Z'),
        submitted_by: OWNER,
        manager_approved_at: null,
        final_approved_at: null,
        reopened_at: null,
      },
      counts: { submitted: 5 },
    });
    const ctrl = makeController(prisma);
    const out = await ctrl.getOne(owner, '2026-W21');
    expect(out).toMatchObject({ status: 'submitted', id: '7' });
    expect(out.entry_counts).toMatchObject({ submitted: 5 });
  });
});

describe('POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock — admin unlock-week', () => {
  it('rejects a reason shorter than 20 characters', async () => {
    const ctrl = makeController(makePrisma());
    await expect(ctrl.unlockWeek(admin, OWNER, '2026-W21', { reason: 'too short' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('rejects a malformed iso_week', async () => {
    const ctrl = makeController(makePrisma());
    await expect(
      ctrl.unlockWeek(admin, OWNER, '2026-21', { reason: 'a reason long enough to satisfy the 20-char minimum' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('loops the per-entry admin-unlock over every locked entry, writes history + audit, recomputes', async () => {
    const lockedEntries = [
      { id: '20', status: 'final_approved' },
      { id: '21', status: 'manager_approved' },
    ];
    const prisma = makePrisma({ lockedEntries, counts: { draft: 2 }, periodRow: { status: 'final_approved' } });
    const ctrl = makeController(prisma);
    const out = await ctrl.unlockWeek(admin, OWNER, '2026-W21', {
      reason: 'correcting an over-approved week — needs re-coding per finance',
    });
    expect(out.unlocked_ids).toEqual(['20', '21']);
    // Two entry UPDATEs to draft.
    const updates = prisma.calls.filter((c) => /UPDATE time_entries SET status = 'draft'/.test(c.sql));
    expect(updates).toHaveLength(2);
    // Two history rows preserving from_status.
    const history = prisma.calls.filter((c) => /INSERT INTO time_entry_state_history/.test(c.sql));
    expect(history).toHaveLength(2);
    expect(history[0]!.values[1]).toBe('final_approved');
    expect(history[1]!.values[1]).toBe('manager_approved');
    // Audit rows mirror admin_unlock.
    expect(noopAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approval.admin_unlock', entityType: 'time_entry' }),
    );
    // Recompute pulled the period to open (counts show draft only).
    const recompute = prisma.calls.find((c) => /UPDATE timesheet_periods SET/.test(c.sql));
    expect(recompute).toBeDefined();
    expect(String(recompute!.values[3])).toBe('open');
  });

  it('returns an empty unlocked_ids list when the week has no locked entries', async () => {
    const prisma = makePrisma({ lockedEntries: [], counts: {}, periodRow: null });
    const ctrl = makeController(prisma);
    const out = await ctrl.unlockWeek(admin, OWNER, '2026-W21', {
      reason: 'nothing to unlock but exercising the loop boundary safely here',
    });
    expect(out.unlocked_ids).toEqual([]);
  });
});

describe('GET /v1/timesheet-periods — list (self + RBAC)', () => {
  it('scopes to visible users when not unrestricted', async () => {
    const prisma = makePrisma({ periodRow: null });
    const ctrl = makeController(prisma, makeRbac(false));
    const out = await ctrl.list(owner, { limit: 50 });
    expect(out).toHaveProperty('data');
    // The ANY($n::bigint[]) scope clause is present.
    const listSql = prisma.calls.find((c) => /FROM timesheet_periods tp/.test(c.sql));
    expect(listSql!.sql).toMatch(/tp\.user_id = ANY/);
  });
});
