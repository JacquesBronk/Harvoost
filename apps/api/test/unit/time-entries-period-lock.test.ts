import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { PeriodService } from '../../src/timesheet-periods/period.service';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { PeriodLockedError, NotFoundError } from '@harvoost/shared';
import type { RbacScopeService } from '@harvoost/shared';

// FEAT-002 (issue #6) — PERIOD_LOCKED enforcement points + submit-week, using a REAL PeriodService
// over an in-memory Prisma stub. The stub recognizes the period/EXTRACT/entry SQL so the service's
// rollup + lock logic runs end-to-end against scripted data.

const OWNER = '3';
const TZ = 'Africa/Johannesburg';

// A configurable in-memory Prisma stub.
function makePrisma(opts: {
  // status of the timesheet_periods row for the resolved week (null = no row = open).
  periodStatus?: string | null;
  // status of the existing entry for PATCH/DELETE lookups.
  entryStatus?: string;
  entryOwner?: string;
  entryStartAt?: string;
  // entries returned by the submit week-scope query: [{ id, status }]
  weekEntries?: Array<{ id: string; status: string }>;
  // recompute GROUP BY counts after the submit UPDATEs (defaults to derived from weekEntries).
  recomputeCounts?: Record<string, number>;
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
      if (sql.includes('SELECT body_hash, response FROM idempotency_keys')) return [];
      if (sql.includes('SELECT timezone FROM users')) return [{ timezone: TZ }];
      if (sql.includes('EXTRACT(ISOYEAR FROM') && sql.includes('AS iso_year')) {
        return [{ iso_year: isoYear, iso_week: isoWeek, week_start: '2026-05-18' }];
      }
      if (sql.includes('SELECT status FROM timesheet_periods')) {
        return opts.periodStatus ? [{ status: opts.periodStatus }] : [];
      }
      // recompute GROUP BY status
      if (sql.includes('COUNT(*)::int AS n') && sql.includes('GROUP BY status')) {
        const counts = opts.recomputeCounts ?? deriveCounts(opts.weekEntries ?? []);
        return Object.entries(counts).map(([status, n]) => ({ status, n }));
      }
      // submit anchor lookup: SELECT user_id, status, start_at FROM time_entries WHERE id
      if (sql.includes('SELECT user_id, status, start_at FROM time_entries')) {
        return [
          {
            user_id: opts.entryOwner ?? OWNER,
            status: opts.entryStatus ?? 'draft',
            start_at: opts.entryStartAt ?? '2026-05-20T08:00:00Z',
          },
        ];
      }
      // submit week-scope candidate query
      if (sql.includes('SELECT id, status FROM time_entries') && sql.includes('EXTRACT(ISOYEAR')) {
        return opts.weekEntries ?? [];
      }
      // PATCH/DELETE existing-row lookup (starts with SELECT status, user_id, project_id ...)
      if (sql.includes('FROM time_entries') && sql.includes('SELECT status, user_id')) {
        return [
          {
            status: opts.entryStatus ?? 'draft',
            user_id: opts.entryOwner ?? OWNER,
            project_id: '1',
            task_id: null,
            notes: null,
            start_at: opts.entryStartAt ?? '2026-05-20T08:00:00Z',
            end_at: '2026-05-20T09:00:00Z',
            billable: true,
          },
        ];
      }
      // createManual INSERT ... RETURNING
      if (sql.includes('INSERT INTO time_entries') && sql.includes('RETURNING')) {
        return [
          {
            id: '900',
            user_id: OWNER,
            project_id: String(values[1] ?? '1'),
            task_id: null,
            notes: null,
            start_at: new Date('2026-05-20T08:00:00Z'),
            end_at: new Date('2026-05-20T09:00:00Z'),
            status: 'draft',
            billable: true,
          },
        ];
      }
      // overlap pre-check
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

function deriveCounts(entries: Array<{ status: string }>): Record<string, number> {
  const c: Record<string, number> = {};
  for (const e of entries) {
    const s = e.status === 'draft' ? 'submitted' : e.status; // after submit, drafts became submitted
    if (s === 'running') continue;
    c[s] = (c[s] ?? 0) + 1;
  }
  return c;
}

function makeRbac(): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: [OWNER], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
    getVisibleProjectIds: async () => ({ projectIds: ['1'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
    assertCanSeeProject: async () => undefined,
    assertCanSeeUser: async () => undefined,
  } as unknown as RbacScopeService;
}

const noopAudit = { record: async () => undefined };
const noopSync = { emit: () => {}, subscribe: () => ({ subject: {}, unsubscribe: () => {} }), subscriberCount: () => 0 };

function makeController(prisma: ReturnType<typeof makePrisma>): TimeEntriesController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idem = new IdempotencyService(prisma as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const periods = new PeriodService(prisma as any);
  return new TimeEntriesController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    idem,
    makeRbac(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    noopAudit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    noopSync as any,
    periods,
  );
}

const owner = { userId: OWNER, email: 'o@h.local', roles: ['employee'] };

describe('createManual — PERIOD_LOCKED enforcement (DESIGN §3, load-bearing)', () => {
  it('rejects a create whose start_at lands in a submitted week with PERIOD_LOCKED 409', async () => {
    const prisma = makePrisma({ periodStatus: 'submitted' });
    const ctrl = makeController(prisma);
    await expect(
      ctrl.createManual(owner, {
        project_id: '1',
        start_at: '2026-05-20T08:00:00Z',
        end_at: '2026-05-20T09:00:00Z',
      }),
    ).rejects.toBeInstanceOf(PeriodLockedError);
  });

  it('allows a create into an empty/future week (no period row)', async () => {
    const prisma = makePrisma({ periodStatus: null });
    const ctrl = makeController(prisma);
    const out = await ctrl.createManual(owner, {
      project_id: '1',
      start_at: '2026-05-20T08:00:00Z',
      end_at: '2026-05-20T09:00:00Z',
    });
    expect(out).toMatchObject({ id: '900' });
  });

  it('allows a create when the week is rejected (reopened for fixes)', async () => {
    const prisma = makePrisma({ periodStatus: 'rejected' });
    const ctrl = makeController(prisma);
    const out = await ctrl.createManual(owner, {
      project_id: '1',
      start_at: '2026-05-20T08:00:00Z',
      end_at: '2026-05-20T09:00:00Z',
    });
    expect(out).toMatchObject({ id: '900' });
  });
});

describe('PATCH — PERIOD_LOCKED on a destination-week move (the PATCH-move hole)', () => {
  it('rejects moving a draft entry whose NEW start_at lands in a locked week', async () => {
    const prisma = makePrisma({ periodStatus: 'manager_approved', entryStatus: 'draft' });
    const ctrl = makeController(prisma);
    await expect(
      ctrl.edit(owner, '42', { start_at: '2026-05-20T08:00:00Z' }),
    ).rejects.toBeInstanceOf(PeriodLockedError);
  });

  it('allows a notes-only PATCH even if the week were locked (no start_at/end_at change → no period check)', async () => {
    const prisma = makePrisma({ periodStatus: 'submitted', entryStatus: 'draft' });
    const ctrl = makeController(prisma);
    // start_at unchanged → the destination-period check is skipped; own-status is draft so ENTRY_LOCKED also passes.
    const out = await ctrl.edit(owner, '42', { notes: 'just a note' });
    expect(out).toEqual({ ok: true });
  });

  it('the entry own-status ENTRY_LOCKED check fires FIRST (submitted entry, before the period check)', async () => {
    const prisma = makePrisma({ periodStatus: 'submitted', entryStatus: 'submitted' });
    const ctrl = makeController(prisma);
    // A submitted entry → ENTRY_LOCKED (not PERIOD_LOCKED) per the ordered checks.
    await expect(ctrl.edit(owner, '42', { start_at: '2026-05-20T08:00:00Z' })).rejects.toThrowError(
      /status submitted/i,
    );
  });
});

describe('DELETE — PERIOD_LOCKED hardening (block deleting a draft out of a locked week)', () => {
  it('rejects deleting a draft entry that lands in a locked (submitted) week', async () => {
    const prisma = makePrisma({ periodStatus: 'submitted', entryStatus: 'draft' });
    const ctrl = makeController(prisma);
    await expect(ctrl.remove(owner, '42')).rejects.toBeInstanceOf(PeriodLockedError);
  });

  it('allows deleting a draft entry in an open week', async () => {
    const prisma = makePrisma({ periodStatus: null, entryStatus: 'draft' });
    const ctrl = makeController(prisma);
    await expect(ctrl.remove(owner, '42')).resolves.toEqual({ ok: true });
  });
});

describe('start/switch — defensive PERIOD_LOCKED on the current week', () => {
  it('start: rejects when the current week is already submitted', async () => {
    const prisma = makePrisma({ periodStatus: 'submitted' });
    const ctrl = makeController(prisma);
    await expect(ctrl.start(owner, 'idem-1', { project_id: '1' })).rejects.toBeInstanceOf(
      PeriodLockedError,
    );
  });

  it('switch: rejects when the current week is already submitted', async () => {
    const prisma = makePrisma({ periodStatus: 'submitted' });
    const ctrl = makeController(prisma);
    await expect(ctrl.switch(owner, 'idem-2', { project_id: '1' })).rejects.toBeInstanceOf(
      PeriodLockedError,
    );
  });

  it('start: succeeds into an open week', async () => {
    const prisma = makePrisma({ periodStatus: null });
    const ctrl = makeController(prisma);
    const out = await ctrl.start(owner, 'idem-3', { project_id: '1' });
    expect(out).toMatchObject({ status: 'draft' }); // INSERT RETURNING stub uses draft here
  });
});

describe('submit — scope=week (DESIGN §4)', () => {
  it('flips the week`s drafts to submitted, skips running + already-submitted, returns submitted_ids + skipped', async () => {
    const weekEntries = [
      { id: '10', status: 'draft' },
      { id: '11', status: 'draft' },
      { id: '12', status: 'running' },
      { id: '13', status: 'submitted' },
    ];
    const prisma = makePrisma({ periodStatus: null, weekEntries });
    const ctrl = makeController(prisma);
    const out = await ctrl.submit(owner, '10', { scope: 'week' });
    expect(out.submitted_ids).toEqual(['10', '11']);
    expect(out.skipped).toEqual([
      { entry_id: '12', reason: 'running' },
      { entry_id: '13', reason: 'already_submitted' },
    ]);
    // Two draft→submitted UPDATEs + two history inserts.
    const updates = prisma.calls.filter(
      (c) => /UPDATE time_entries SET status = 'submitted'/.test(c.sql),
    );
    expect(updates).toHaveLength(2);
    const history = prisma.calls.filter(
      (c) => /INSERT INTO time_entry_state_history/.test(c.sql) && /'draft', 'submitted'/.test(c.sql),
    );
    expect(history).toHaveLength(2);
    // The submit path upserts the period row to stamp submitted_at/submitted_by (3-param call).
    const upsert = prisma.calls.find(
      (c) => /INSERT INTO timesheet_periods/.test(c.sql) && /submitted_at/.test(c.sql) && c.values.length === 3,
    );
    expect(upsert).toBeDefined();
    // recompute then writes the authoritative derived status 'submitted' ($4 = newStatus). With no
    // pre-existing period row in the stub, recompute takes the INSERT branch (4 params).
    const recompute = prisma.calls.find(
      (c) => /INSERT INTO timesheet_periods|UPDATE timesheet_periods SET/.test(c.sql) && c.values.length === 4,
    );
    expect(recompute).toBeDefined();
    expect(String(recompute!.values[3])).toBe('submitted');
  });

  it('is self-only: submitting another user`s entry returns 404', async () => {
    const prisma = makePrisma({ entryOwner: '999' });
    const ctrl = makeController(prisma);
    await expect(ctrl.submit(owner, '10', { scope: 'week' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404 when the anchor entry does not exist', async () => {
    const prisma = makePrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT user_id, status, start_at FROM time_entries')) return [];
      return [];
    });
    const ctrl = makeController(prisma);
    await expect(ctrl.submit(owner, '404', { scope: 'week' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('scope=entry submits just the anchor draft entry', async () => {
    const prisma = makePrisma({ entryStatus: 'draft' });
    const ctrl = makeController(prisma);
    const out = await ctrl.submit(owner, '55', { scope: 'entry' });
    expect(out.submitted_ids).toEqual(['55']);
    expect(out.skipped).toEqual([]);
  });

  it('scope=entry skips a running anchor entry (does not 500)', async () => {
    const prisma = makePrisma({ entryStatus: 'running' });
    const ctrl = makeController(prisma);
    const out = await ctrl.submit(owner, '55', { scope: 'entry' });
    expect(out.submitted_ids).toEqual([]);
    expect(out.skipped).toEqual([{ entry_id: '55', reason: 'running' }]);
  });
});
