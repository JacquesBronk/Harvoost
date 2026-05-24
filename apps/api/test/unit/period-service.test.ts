import { describe, it, expect, vi } from 'vitest';
import { PeriodService, mapPeriodLockDbError, LOCKED_PERIOD_STATUSES } from '../../src/timesheet-periods/period.service';
import { PeriodLockedError } from '@harvoost/shared';

// FEAT-002 (issue #6) — PeriodService rollup + lock-oracle + HV001 mapping.
// In-memory Prisma stub keyed on SQL substrings (mirrors the existing controller-test style).

interface PeriodSeed {
  status: string;
}

// counts: a status→count map for the recompute GROUP BY query.
function makePrisma(opts: {
  isoYear?: number;
  isoWeek?: number;
  weekStart?: string;
  tz?: string;
  period?: PeriodSeed | null; // the SELECT status FROM timesheet_periods result
  counts?: Record<string, number>;
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const isoYear = opts.isoYear ?? 2026;
  const isoWeek = opts.isoWeek ?? 21;
  const weekStart = opts.weekStart ?? '2026-05-18';
  const tz = opts.tz ?? 'Africa/Johannesburg';

  const stub = {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT timezone FROM users')) {
        return [{ timezone: tz }];
      }
      // resolveWeek EXTRACT query (single row).
      if (sql.includes('EXTRACT(ISOYEAR FROM') && sql.includes('AS iso_year')) {
        return [{ iso_year: isoYear, iso_week: isoWeek, week_start: weekStart }];
      }
      // recompute GROUP BY status.
      if (sql.includes('COUNT(*)::int AS n') && sql.includes('GROUP BY status')) {
        const counts = opts.counts ?? {};
        return Object.entries(counts).map(([status, n]) => ({ status, n }));
      }
      // SELECT status FROM timesheet_periods (lock check + recompute existing-row probe).
      if (sql.includes('SELECT status FROM timesheet_periods')) {
        return opts.period ? [{ status: opts.period.status }] : [];
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

describe('PeriodService.assertPeriodWritable (DESIGN §3)', () => {
  it('allows a write when no period row exists (implicit open week)', async () => {
    const prisma = makePrisma({ period: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PeriodService(prisma as any);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc.assertPeriodWritable(prisma as any, '3', 'Africa/Johannesburg', new Date('2026-05-20T08:00:00Z')),
    ).resolves.toBeUndefined();
  });

  it.each(['submitted', 'manager_approved', 'final_approved'])(
    'throws PeriodLockedError when the period is %s',
    async (status) => {
      const prisma = makePrisma({ period: { status } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new PeriodService(prisma as any);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        svc.assertPeriodWritable(prisma as any, '3', 'Africa/Johannesburg', '2026-05-20T08:00:00Z'),
      ).rejects.toBeInstanceOf(PeriodLockedError);
    },
  );

  it.each(['open', 'rejected'])('allows a write when the period is %s (not locked)', async (status) => {
    const prisma = makePrisma({ period: { status } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PeriodService(prisma as any);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc.assertPeriodWritable(prisma as any, '3', 'Africa/Johannesburg', '2026-05-20T08:00:00Z'),
    ).resolves.toBeUndefined();
  });

  it('the locked set matches LOCKED_STATUSES exactly (DESIGN §2)', () => {
    expect([...LOCKED_PERIOD_STATUSES].sort()).toEqual(
      ['final_approved', 'manager_approved', 'submitted'].sort(),
    );
  });
});

describe('PeriodService.recomputePeriod rollup (DESIGN §2)', () => {
  // The rollup is exercised through the UPDATE/INSERT the service emits. We assert the chosen
  // status by reading the status param the service binds.
  async function recomputeStatus(
    counts: Record<string, number>,
    period: PeriodSeed | null,
  ): Promise<{ sql: string; status: string | null }> {
    const prisma = makePrisma({ counts, period });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PeriodService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.recomputePeriod(prisma as any, '3', 'Africa/Johannesburg', 2026, 21);
    const write = prisma.calls.find(
      (c) => /INSERT INTO timesheet_periods|UPDATE timesheet_periods SET/.test(c.sql),
    );
    if (!write) return { sql: '', status: null };
    // status is the 4th positional param ($4) in both the INSERT and UPDATE.
    return { sql: write.sql, status: String(write.values[3]) };
  }

  it('all final_approved → final_approved', async () => {
    const { status } = await recomputeStatus({ final_approved: 3 }, { status: 'manager_approved' });
    expect(status).toBe('final_approved');
  });

  it('all >= manager_approved (mix of manager + final) → manager_approved', async () => {
    const { status } = await recomputeStatus(
      { manager_approved: 2, final_approved: 1 },
      { status: 'submitted' },
    );
    expect(status).toBe('manager_approved');
  });

  it('all >= submitted → submitted', async () => {
    const { status } = await recomputeStatus({ submitted: 4 }, { status: 'submitted' });
    expect(status).toBe('submitted');
  });

  it('any rejected → rejected (week reopens for fixes)', async () => {
    const { status } = await recomputeStatus(
      { rejected: 1, final_approved: 2 },
      { status: 'manager_approved' },
    );
    expect(status).toBe('rejected');
  });

  it('>= 1 draft (partial week) → open', async () => {
    const { status } = await recomputeStatus({ draft: 1, submitted: 3 }, { status: 'submitted' });
    expect(status).toBe('open');
  });

  it('admin-unlock case: a final_approved week with one entry dropped to draft → open + reopened_at', async () => {
    const prisma = makePrisma({
      counts: { draft: 1, final_approved: 2 },
      period: { status: 'final_approved' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PeriodService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.recomputePeriod(prisma as any, '3', 'Africa/Johannesburg', 2026, 21);
    const update = prisma.calls.find((c) => /UPDATE timesheet_periods SET/.test(c.sql));
    expect(update).toBeDefined();
    expect(String(update!.values[3])).toBe('open');
    // reopened flag ($5) must be true — dropped out of a locked status.
    expect(update!.values[4]).toBe(true);
  });

  it('empty week with NO existing row → no write (open weeks have no row, DESIGN §1)', async () => {
    const prisma = makePrisma({ counts: {}, period: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new PeriodService(prisma as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await svc.recomputePeriod(prisma as any, '3', 'Africa/Johannesburg', 2026, 21);
    const write = prisma.calls.find(
      (c) => /INSERT INTO timesheet_periods|UPDATE timesheet_periods SET/.test(c.sql),
    );
    expect(write).toBeUndefined();
  });
});

describe('mapPeriodLockDbError — SQLSTATE HV001 → PeriodLockedError (HANDOFF_db)', () => {
  it('maps an error carrying code HV001 to PeriodLockedError with parsed details', () => {
    const dbErr = Object.assign(new Error('Cannot write into week 2026-W21 — it is submitted and locked (PERIOD_LOCKED).'), {
      code: 'HV001',
      detail: 'iso_year=2026 iso_week=21 status=submitted',
    });
    const mapped = mapPeriodLockDbError(dbErr);
    expect(mapped).toBeInstanceOf(PeriodLockedError);
    const e = mapped as PeriodLockedError;
    expect(e.details).toMatchObject({ iso_year: 2026, iso_week: 21, status: 'submitted' });
  });

  it('maps when the SQLSTATE is on meta.code (Prisma raw surface)', () => {
    const dbErr = Object.assign(new Error('boom'), { meta: { code: 'HV001' }, detail: 'iso_year=2025 iso_week=9 status=final_approved' });
    const mapped = mapPeriodLockDbError(dbErr);
    expect(mapped).toBeInstanceOf(PeriodLockedError);
    expect((mapped as PeriodLockedError).details).toMatchObject({ iso_year: 2025, iso_week: 9, status: 'final_approved' });
  });

  it('parses iso_year/week from the message body when DETAIL is absent', () => {
    const dbErr = Object.assign(new Error('Cannot write into week 2026-W07 — it is manager_approved and locked (PERIOD_LOCKED).'), { code: 'HV001' });
    const mapped = mapPeriodLockDbError(dbErr);
    expect(mapped).toBeInstanceOf(PeriodLockedError);
    expect((mapped as PeriodLockedError).details).toMatchObject({ iso_year: 2026, iso_week: 7, status: 'manager_approved' });
  });

  it('passes through a non-HV001 error untouched (e.g. a unique violation)', () => {
    const other = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(mapPeriodLockDbError(other)).toBe(other);
  });

  it('passes through null / non-object inputs', () => {
    expect(mapPeriodLockDbError(null)).toBe(null);
    expect(mapPeriodLockDbError('nope')).toBe('nope');
  });
});
