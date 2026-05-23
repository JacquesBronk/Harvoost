import { describe, it, expect, vi } from 'vitest';
import { exceptionDetection } from '../exception-detection';
import type { JobDeps } from '../../types';

function makeDeps() {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const logs: Array<{ msg: string; meta?: unknown }> = [];
  const deps: JobDeps = {
    prisma: {
      $queryRawUnsafe: vi.fn(async () => []) as unknown as JobDeps['prisma']['$queryRawUnsafe'],
      $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
        executed.push({ sql, values });
        return 0;
      }) as unknown as JobDeps['prisma']['$executeRawUnsafe'],
    },
    llm: {
      provider: 'mock',
      model: 'mock-test',
      capabilities: () => ({ supportsTools: true, supportsStreaming: false }),
      generateText: async () => ({ text: '', usage: { promptTokens: 0, completionTokens: 0 } }),
      generateWithTools: async () => ({ text: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } }),
    },
    mailer: { send: async () => ({ messageId: 'test' }) },
    logger: {
      info: (msg, meta) => logs.push({ msg, meta }),
      warn: (msg, meta) => logs.push({ msg, meta }),
      error: (msg, meta) => logs.push({ msg, meta }),
    },
  };
  return { deps, executed, logs };
}

describe('exception.nightly_batch (REQUIREMENTS F8)', () => {
  it('declares the documented cron (daily 02:00 UTC)', () => {
    expect(exceptionDetection.cron).toBe('0 2 * * *');
    expect(exceptionDetection.name).toBe('exception.nightly_batch');
  });

  it('issues a MISSED_PUNCH INSERT joining schedule_templates + LEFT-JOIN time_entries + LEFT-JOIN leave_requests', async () => {
    const { deps, executed } = makeDeps();
    await exceptionDetection.handler(null, deps);
    const missed = executed.find((e) => e.sql.includes("'MISSED_PUNCH'"));
    expect(missed).toBeDefined();
    // Must check NOT EXISTS on both time_entries and leave_requests.
    expect(missed!.sql).toMatch(/NOT EXISTS.*time_entries/is);
    expect(missed!.sql).toMatch(/NOT EXISTS.*leave_requests/is);
    expect(missed!.sql).toMatch(/schedule_templates/);
  });

  it('uses the user`s local TZ for the prior-day date (not server UTC)', async () => {
    const { deps, executed } = makeDeps();
    await exceptionDetection.handler(null, deps);
    const missed = executed.find((e) => e.sql.includes("'MISSED_PUNCH'"));
    // Architecture: (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date.
    expect(missed!.sql).toMatch(/NOW\(\)\s+AT\s+TIME\s+ZONE\s+u\.timezone/i);
  });

  it('respects working_days array — only ISODOW members count as scheduled', async () => {
    const { deps, executed } = makeDeps();
    await exceptionDetection.handler(null, deps);
    const missed = executed.find((e) => e.sql.includes("'MISSED_PUNCH'"));
    expect(missed!.sql).toMatch(/EXTRACT\(ISODOW.*= ANY\(st\.working_days\)/is);
  });

  it('issues an OVERTIME_DAY INSERT comparing summed hours to the env-configured daily threshold', async () => {
    const { deps, executed } = makeDeps();
    await exceptionDetection.handler(null, deps);
    const ot = executed.find((e) => e.sql.includes("'OVERTIME_DAY'"));
    expect(ot).toBeDefined();
    // Threshold is now bound as $1::numeric (was: org_settings.overtime_daily_hours column ref).
    // We assert the HAVING clause compares the summed hours to the bind parameter and that
    // the threshold value is passed as the first bind (default 10 from OT_DAY_THRESHOLD_HOURS).
    expect(ot!.sql).toMatch(/HAVING\s+SUM\(EXTRACT\(EPOCH[\s\S]*\$1::numeric/i);
    expect(ot!.sql).toMatch(/SUM\(EXTRACT\(EPOCH/i);
    expect(ot!.values[0]).toBe(Number(process.env.OT_DAY_THRESHOLD_HOURS ?? 10));
  });

  it('all insert statements use ON CONFLICT DO NOTHING (idempotent re-run dedup)', async () => {
    const { deps, executed } = makeDeps();
    await exceptionDetection.handler(null, deps);
    const inserts = executed.filter((e) => e.sql.includes('INSERT INTO exceptions'));
    for (const ins of inserts) {
      expect(ins.sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
    }
  });

  it('logs success at the end', async () => {
    const { deps, logs } = makeDeps();
    await exceptionDetection.handler(null, deps);
    const ok = logs.find((l) => l.msg === 'exception.nightly_batch.ok');
    expect(ok).toBeDefined();
    expect(ok!.meta).toHaveProperty('durationMs');
  });
});
