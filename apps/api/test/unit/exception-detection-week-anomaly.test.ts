import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exceptionDetection } from '@harvoost/jobs';

// Items 5+6: assert the nightly batch issues 4 INSERTs in order — missed_punch,
// overtime_day, overtime_week, anomaly — and that env-driven thresholds bind in.

function capturingPrisma() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async () => []),
  };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('exception.nightly_batch — week + anomaly detection', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('runs all 4 INSERTs (missed_punch, OT_day, OT_week, anomaly)', async () => {
    const prisma = capturingPrisma();
    await exceptionDetection.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger: fakeLogger() } as any,
    );
    expect(prisma.calls.length).toBeGreaterThanOrEqual(4);
    const sqls = prisma.calls.map((c) => c.sql);
    expect(sqls.some((s) => /MISSED_PUNCH/.test(s))).toBe(true);
    expect(sqls.some((s) => /OVERTIME_DAY/.test(s))).toBe(true);
    expect(sqls.some((s) => /OVERTIME_WEEK/.test(s))).toBe(true);
    expect(sqls.some((s) => /ANOMALY_LOW.*ANOMALY_HIGH/s.test(s))).toBe(true);
  });

  it('respects OT_DAY_THRESHOLD_HOURS env override (binds as $1)', async () => {
    process.env.OT_DAY_THRESHOLD_HOURS = '8';
    const prisma = capturingPrisma();
    await exceptionDetection.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger: fakeLogger() } as any,
    );
    const otDayCall = prisma.calls.find((c) => /OVERTIME_DAY/.test(c.sql));
    expect(otDayCall).toBeDefined();
    expect(otDayCall!.values[0]).toBe(8);
    delete process.env.OT_DAY_THRESHOLD_HOURS;
  });

  it('respects OT_WEEK_THRESHOLD_HOURS env override (binds as $1)', async () => {
    process.env.OT_WEEK_THRESHOLD_HOURS = '45';
    const prisma = capturingPrisma();
    await exceptionDetection.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger: fakeLogger() } as any,
    );
    const otWeekCall = prisma.calls.find((c) => /OVERTIME_WEEK/.test(c.sql));
    expect(otWeekCall).toBeDefined();
    expect(otWeekCall!.values[0]).toBe(45);
    delete process.env.OT_WEEK_THRESHOLD_HOURS;
  });

  it('anomaly query is gated by stdev > 0.1 (suppresses noise)', async () => {
    const prisma = capturingPrisma();
    await exceptionDetection.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger: fakeLogger() } as any,
    );
    const anomalyCall = prisma.calls.find((c) => /ANOMALY_LOW/.test(c.sql));
    expect(anomalyCall).toBeDefined();
    expect(anomalyCall!.sql).toMatch(/std_h > 0\.1/);
    expect(anomalyCall!.sql).toMatch(/ABS\(hours - mean_h\) > \$1::numeric \* std_h/);
  });

  it('on-conflict dedup is present for every INSERT', async () => {
    const prisma = capturingPrisma();
    await exceptionDetection.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, llm: {} as any, mailer: {} as any, logger: fakeLogger() } as any,
    );
    for (const call of prisma.calls) {
      if (/INSERT INTO exceptions/.test(call.sql)) {
        expect(call.sql).toMatch(/ON CONFLICT.*DO NOTHING/);
      }
    }
  });
});
