import { describe, it, expect, vi } from 'vitest';
import { CostRatesController } from '../../src/cost-rates/cost-rates.controller';
import { ValidationFailedError } from '@harvoost/shared';

// INC-004 Row 4 — CostRatesController.
// Asserts: GET current + history envelope, POST creates an effective-dated row
// (end-dating the prior open row), 23P01 → clean conflict, created_by set,
// audit recorded.

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
          if (opts.insertThrows === 'overlap' && sql.includes('INSERT INTO employee_cost_rates')) {
            throw Object.assign(new Error('conflicting key value violates exclusion constraint "ecr_no_overlap"'), { code: '23P01' });
          }
          if (sql.includes('INSERT INTO employee_cost_rates')) {
            return [
              {
                id: 7,
                user_id: 20,
                rate: '85.00',
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

describe('CostRatesController — GET', () => {
  it('returns OffsetPaginated envelope for current rates', async () => {
    const prisma = makePrismaStub({
      rows: [
        { id: 1, user_id: 20, user_display_name: 'Bob', rate: '85.00', currency: 'EUR', effective_from: '2026-01-01', effective_to: null, created_by: 1, created_at: '2026-01-01T00:00:00.000Z' },
      ],
      total: 1,
    });
    const ctrl = new CostRatesController(prisma as any, makeAuditStub() as any);
    const out = await ctrl.list('true', undefined, '1', '50');
    expect(out.page).toBe(1);
    expect(out.page_size).toBe(50);
    expect(out.total_count).toBe(1);
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toMatchObject({ user_id: '20', rate: 85, currency: 'EUR', effective_to: null });
  });

  it('history query filters by user_id', async () => {
    const prisma = makePrismaStub({ rows: [], total: 0 });
    const ctrl = new CostRatesController(prisma as any, makeAuditStub() as any);
    await ctrl.list(undefined, '20', '1', '100');
    const sqlCalls = prisma.$queryRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => s.includes('WHERE ecr.user_id = $1::bigint'))).toBe(true);
  });

  it('rejects a non-numeric user_id', async () => {
    const ctrl = new CostRatesController(makePrismaStub() as any, makeAuditStub() as any);
    await expect(ctrl.list(undefined, 'abc', '1', '50')).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('CostRatesController — POST', () => {
  it('end-dates the prior open row, sets created_by, returns the new row, records audit', async () => {
    const prisma = makePrismaStub();
    const audit = makeAuditStub();
    const ctrl = new CostRatesController(prisma as any, audit as any);
    const out = await ctrl.create(admin, {
      user_id: '20',
      rate: 85,
      currency: 'EUR',
      effective_from: '2026-06-01',
    });
    expect(out).toMatchObject({ id: '7', user_id: '20', rate: 85, currency: 'EUR', created_by: '1' });
    // The prior open row is end-dated within the transaction.
    expect(prisma.executed.some((s) => s.includes('UPDATE employee_cost_rates') && s.includes('effective_to'))).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cost_rate.create', entityType: 'employee_cost_rate', actorId: '1' }),
    );
  });

  it('maps a 23P01 exclusion violation to a clean validation conflict', async () => {
    const prisma = makePrismaStub({ insertThrows: 'overlap' });
    const ctrl = new CostRatesController(prisma as any, makeAuditStub() as any);
    await expect(
      ctrl.create(admin, { user_id: '20', rate: 85, currency: 'EUR', effective_from: '2026-06-01' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
