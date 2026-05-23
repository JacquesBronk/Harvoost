import { describe, it, expect, vi } from 'vitest';
import { moodRetention } from '../mood-retention';
import type { JobDeps } from '../../types';

function makeDeps(): { deps: JobDeps; executed: Array<{ sql: string; values: unknown[] }>; logs: Array<{ msg: string }> } {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const logs: Array<{ msg: string }> = [];
  const deps: JobDeps = {
    prisma: {
      $queryRawUnsafe: vi.fn(async () => []) as unknown as JobDeps['prisma']['$queryRawUnsafe'],
      $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
        executed.push({ sql, values });
        // The 3rd executeRawUnsafe call (DELETE) returns a row count; simulate 0 deletions for unit test.
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
      info: (msg) => logs.push({ msg }),
      warn: (msg) => logs.push({ msg }),
      error: (msg) => logs.push({ msg }),
    },
  };
  return { deps, executed, logs };
}

describe('mood.retention_job (REQUIREMENTS F1.3, ARCHITECTURE § Mood retention)', () => {
  it('declares the documented cron (daily 03:30 UTC)', () => {
    expect(moodRetention.cron).toBe('30 3 * * *');
    expect(moodRetention.name).toBe('mood.retention_job');
  });

  it('issues an INSERT into mood_weekly_aggregates for project anchors with k>=5 HAVING clause', async () => {
    const { deps, executed } = makeDeps();
    await moodRetention.handler(null, deps);
    const projAnchor = executed.find((e) => e.sql.includes("'proj:'") && e.sql.includes('mood_weekly_aggregates'));
    expect(projAnchor).toBeDefined();
    // k>=5 must be enforced at write time, not at query time.
    expect(projAnchor!.sql).toMatch(/HAVING COUNT\(DISTINCT me\.user_id\) >= 5/);
  });

  it('issues an INSERT for manager anchors with the same k>=5 guard', async () => {
    const { deps, executed } = makeDeps();
    await moodRetention.handler(null, deps);
    const mgrAnchor = executed.find((e) => e.sql.includes("'mgr:'") && e.sql.includes('mood_weekly_aggregates'));
    expect(mgrAnchor).toBeDefined();
    expect(mgrAnchor!.sql).toMatch(/HAVING COUNT\(DISTINCT me\.user_id\) >= 5/);
  });

  it('issues a DELETE FROM mood_entries with the 90-day cutoff (non-recoverable raw delete)', async () => {
    const { deps, executed } = makeDeps();
    await moodRetention.handler(null, deps);
    const del = executed.find((e) => e.sql.includes('DELETE FROM mood_entries'));
    expect(del).toBeDefined();
    expect(del!.sql).toMatch(/NOW\(\) - INTERVAL '90 days'/);
  });

  it('does NOT delete raw rows before computing aggregates (order matters)', async () => {
    const { deps, executed } = makeDeps();
    await moodRetention.handler(null, deps);
    const aggIdx = executed.findIndex((e) => e.sql.includes('mood_weekly_aggregates'));
    const delIdx = executed.findIndex((e) => e.sql.includes('DELETE FROM mood_entries'));
    expect(aggIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(aggIdx).toBeLessThan(delIdx);
  });

  it('uses ON CONFLICT DO NOTHING for idempotent re-runs', async () => {
    const { deps, executed } = makeDeps();
    await moodRetention.handler(null, deps);
    const aggregateInserts = executed.filter((e) => e.sql.includes('mood_weekly_aggregates'));
    for (const ins of aggregateInserts) {
      expect(ins.sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
    }
  });
});
