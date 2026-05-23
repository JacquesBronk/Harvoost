import { describe, it, expect, vi } from 'vitest';
import { BillableRatesController } from '../../src/billable-rates/billable-rates.controller';
import { ValidationFailedError } from '@harvoost/shared';

// INC-004 Row 5 — BillableRatesController.
// Asserts: GET current + history envelope (incl. task_id null = project default),
// POST creates an effective-dated row (end-dating the prior open tuple-row),
// 23P01 → clean conflict, created_by set, audit recorded.

function makePrismaStub(opts: {
  rows?: Array<Record<string, unknown>>;
  total?: number;
  insertThrows?: 'overlap' | false;
} = {}) {
  const executed: string[] = [];
  const stub = {
    executed,
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return [{ n: opts.total ?? (opts.rows?.length ?? 0) }];
      if (sql.includes('SELECT')) return opts.rows ?? [];
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $executeRawUnsafe: vi.fn(async (sql: string) => {
          executed.push(sql);
          return 1;
        }),
        $queryRawUnsafe: vi.fn(async (sql: string) => {
          if (opts.insertThrows === 'overlap' && sql.includes('INSERT INTO project_billable_rates')) {
            throw Object.assign(new Error('conflicting key value violates exclusion constraint "pbr_no_overlap"'), { code: '23P01' });
          }
          if (sql.includes('INSERT INTO project_billable_rates')) {
            return [
              {
                id: 9,
                project_id: 5,
                task_id: null,
                rate: '150.00',
                currency: 'EUR',
                effective_from: '2026-06-01',
                effective_to: null,
                created_by: 1,
                created_at: '2026-05-23T00:00:00.000Z',
              },
            ];
          }
          return [];
        }),
      };
      return fn(tx);
    }),
  };
  return stub;
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

const admin = { userId: '1', email: 'a@x', roles: ['admin'] };

describe('BillableRatesController — GET', () => {
  it('returns OffsetPaginated envelope; project-default rows carry task_id null', async () => {
    const prisma = makePrismaStub({
      rows: [
        { id: 1, project_id: 5, project_name: 'Atlas', task_id: null, task_name: null, rate: '150.00', currency: 'EUR', effective_from: '2026-01-01', effective_to: null, created_by: 1, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 2, project_id: 5, project_name: 'Atlas', task_id: 7, task_name: 'Design', rate: '180.00', currency: 'EUR', effective_from: '2026-01-01', effective_to: null, created_by: 1, created_at: '2026-01-01T00:00:00.000Z' },
      ],
      total: 2,
    });
    const ctrl = new BillableRatesController(prisma as any, makeAuditStub() as any);
    const out = await ctrl.list('true', undefined, '1', '50');
    expect(out.total_count).toBe(2);
    expect(out.data[0]).toMatchObject({ project_id: '5', task_id: null, rate: 150 });
    expect(out.data[1]).toMatchObject({ project_id: '5', task_id: '7', task_name: 'Design', rate: 180 });
  });

  it('history query filters by project_id', async () => {
    const prisma = makePrismaStub({ rows: [], total: 0 });
    const ctrl = new BillableRatesController(prisma as any, makeAuditStub() as any);
    await ctrl.list(undefined, '5', '1', '100');
    const sqlCalls = prisma.$queryRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => s.includes('WHERE pbr.project_id = $1::bigint'))).toBe(true);
  });

  it('rejects a non-numeric project_id', async () => {
    const ctrl = new BillableRatesController(makePrismaStub() as any, makeAuditStub() as any);
    await expect(ctrl.list(undefined, 'abc', '1', '50')).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('BillableRatesController — POST', () => {
  it('end-dates the prior open tuple-row, sets created_by, returns new row, records audit', async () => {
    const prisma = makePrismaStub();
    const audit = makeAuditStub();
    const ctrl = new BillableRatesController(prisma as any, audit as any);
    const out = await ctrl.create(admin, {
      project_id: '5',
      rate: 150,
      currency: 'EUR',
      effective_from: '2026-06-01',
    });
    expect(out).toMatchObject({ id: '9', project_id: '5', task_id: null, rate: 150, created_by: '1' });
    expect(prisma.executed.some((s) => s.includes('UPDATE project_billable_rates') && s.includes('IS NOT DISTINCT FROM'))).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billable_rate.create', entityType: 'project_billable_rate', actorId: '1' }),
    );
  });

  it('maps a 23P01 exclusion violation to a clean validation conflict', async () => {
    const prisma = makePrismaStub({ insertThrows: 'overlap' });
    const ctrl = new BillableRatesController(prisma as any, makeAuditStub() as any);
    await expect(
      ctrl.create(admin, { project_id: '5', rate: 150, currency: 'EUR', effective_from: '2026-06-01' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
