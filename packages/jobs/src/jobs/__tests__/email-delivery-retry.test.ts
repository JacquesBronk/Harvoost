import { describe, it, expect, vi } from 'vitest';
import { emailDeliveryRetry } from '../email-delivery-retry';

// Unit tests for the email-delivery-retry job (F11.1).
//
// The job sweeps email_delivery_log rows where status='failed' AND
// retry_count < 3 AND next_retry_at <= NOW(). On success it flips the row
// to status='sent'; on failure with attempts < 3 it bumps retry_count and
// schedules the next attempt via exponential backoff (30/60/240 min).
// At the third permanent failure it flips status='failed_permanent'.

function makePrismaStub(candidates: Array<Record<string, unknown>> = []) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  return {
    writes,
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (/FROM email_delivery_log/.test(sql)) {
        return candidates;
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      writes.push({ sql, values });
      return 1;
    }),
  };
}

function makeMailer(opts: { fail?: boolean } = {}) {
  return {
    send: vi.fn(async () => {
      if (opts.fail) throw new Error('SMTP 421 service unavailable');
      return { messageId: 'm-1' };
    }),
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeMetrics() {
  const emissions: Array<{ name: string; value: number; tags?: Record<string, string> }> = [];
  return {
    emissions,
    emit: vi.fn((name: string, value: number, tags?: Record<string, string>) => {
      emissions.push({ name, value, tags });
    }),
  };
}

describe('email.delivery_retry — job contract', () => {
  it('declares cron */5 * * * *', () => {
    expect(emailDeliveryRetry.name).toBe('email.delivery_retry');
    expect(emailDeliveryRetry.cron).toBe('*/5 * * * *');
    expect(emailDeliveryRetry.trigger).toBe('cron');
  });

  it('does nothing when no rows are due (zero processed log line)', async () => {
    const prisma = makePrismaStub();
    const mailer = makeMailer();
    const logger = makeLogger();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, llm: {} as any } as any,
    );
    expect(mailer.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'email.delivery_retry.ok',
      expect.objectContaining({ processed: 0 }),
    );
  });

  it('attempt 1 success: marks row status=sent + sets sent_at + clears error_detail', async () => {
    const prisma = makePrismaStub([
      { id: BigInt(7), user_id: BigInt(42), kind: 'weekly_summary', summary_period_start: '2026-05-11', summary_period_end: '2026-05-17', retry_count: 0, email: 'alice@example.com' },
    ]);
    const mailer = makeMailer();
    const logger = makeLogger();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, llm: {} as any } as any,
    );
    expect(mailer.send).toHaveBeenCalledTimes(1);
    // Find the UPDATE that flips status to 'sent'
    const sentWrite = prisma.writes.find((w) => /status = 'sent'/.test(w.sql));
    expect(sentWrite).toBeDefined();
    expect(sentWrite!.values[0]).toBe('7'); // id positional
  });

  it('attempt 1 failure: schedules next_retry_at = NOW() + 30 minutes + retry_count=1', async () => {
    const prisma = makePrismaStub([
      { id: BigInt(7), user_id: BigInt(42), kind: 'weekly_summary', summary_period_start: '2026-05-11', summary_period_end: '2026-05-17', retry_count: 0, email: 'alice@example.com' },
    ]);
    const mailer = makeMailer({ fail: true });
    const logger = makeLogger();
    const metrics = makeMetrics();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, metrics, llm: {} as any } as any,
    );
    // The UPDATE binds: id, nextAttempt, backoffMinutes, error
    const retryWrite = prisma.writes.find((w) => /next_retry_at = NOW\(\) \+/.test(w.sql));
    expect(retryWrite).toBeDefined();
    expect(retryWrite!.values[1]).toBe(1); // attempt = 0 → next = 1
    expect(retryWrite!.values[2]).toBe('30'); // first backoff = 30 minutes
    expect(metrics.emissions.find((e) => e.tags?.outcome === 'retry')).toBeDefined();
  });

  it('attempt 2 failure: backoff = 60 minutes (1 hour)', async () => {
    const prisma = makePrismaStub([
      { id: BigInt(7), user_id: BigInt(42), kind: 'weekly_summary', summary_period_start: null, summary_period_end: null, retry_count: 1, email: 'alice@example.com' },
    ]);
    const mailer = makeMailer({ fail: true });
    const logger = makeLogger();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, llm: {} as any } as any,
    );
    const retryWrite = prisma.writes.find((w) => /next_retry_at = NOW\(\) \+/.test(w.sql));
    expect(retryWrite).toBeDefined();
    expect(retryWrite!.values[1]).toBe(2);
    expect(retryWrite!.values[2]).toBe('60');
  });

  it('attempt 3 failure: flips status to failed_permanent (no further retries)', async () => {
    const prisma = makePrismaStub([
      { id: BigInt(7), user_id: BigInt(42), kind: 'weekly_summary', summary_period_start: null, summary_period_end: null, retry_count: 2, email: 'alice@example.com' },
    ]);
    const mailer = makeMailer({ fail: true });
    const logger = makeLogger();
    const metrics = makeMetrics();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, metrics, llm: {} as any } as any,
    );
    const permaWrite = prisma.writes.find((w) => /status = 'failed_permanent'/.test(w.sql));
    expect(permaWrite).toBeDefined();
    // No next_retry_at write — only the permanent flip
    expect(prisma.writes.some((w) => /next_retry_at = NOW\(\) \+/.test(w.sql))).toBe(false);
    expect(metrics.emissions.find((e) => e.tags?.outcome === 'permanent')).toBeDefined();
  });

  it('row without email address goes straight to failed_permanent (nothing to send to)', async () => {
    const prisma = makePrismaStub([
      { id: BigInt(99), user_id: BigInt(42), kind: 'weekly_summary', summary_period_start: null, summary_period_end: null, retry_count: 0, email: null },
    ]);
    const mailer = makeMailer();
    const logger = makeLogger();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, llm: {} as any } as any,
    );
    expect(mailer.send).not.toHaveBeenCalled();
    expect(prisma.writes.find((w) => /status = 'failed_permanent'/.test(w.sql))).toBeDefined();
  });

  it('schema-widen ALTER runs at startup (greenfield-safe)', async () => {
    const prisma = makePrismaStub();
    const mailer = makeMailer();
    const logger = makeLogger();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, llm: {} as any } as any,
    );
    const alter = prisma.writes.find((w) => /ALTER TABLE email_delivery_log/.test(w.sql));
    expect(alter).toBeDefined();
    expect(alter!.sql).toMatch(/ADD COLUMN IF NOT EXISTS retry_count/);
    expect(alter!.sql).toMatch(/ADD COLUMN IF NOT EXISTS next_retry_at/);
  });

  it('mixed batch (1 success + 1 retry + 1 permanent) — all three branches in one run', async () => {
    const prisma = makePrismaStub([
      // success path
      { id: BigInt(1), user_id: BigInt(1), kind: 'weekly_summary', summary_period_start: null, summary_period_end: null, retry_count: 0, email: 'ok@x.com' },
      // first retry path (mailer will fail per-call below)
      { id: BigInt(2), user_id: BigInt(2), kind: 'weekly_summary', summary_period_start: null, summary_period_end: null, retry_count: 0, email: 'fail1@x.com' },
      // permanent path
      { id: BigInt(3), user_id: BigInt(3), kind: 'weekly_summary', summary_period_start: null, summary_period_end: null, retry_count: 2, email: 'fail3@x.com' },
    ]);
    // First two emails fail differently — we toggle the mailer's behaviour per call.
    let callIdx = 0;
    const mailer = {
      send: vi.fn(async () => {
        callIdx++;
        if (callIdx === 1) return { messageId: 'sent-1' };
        throw new Error('SMTP transient');
      }),
    };
    const logger = makeLogger();
    await emailDeliveryRetry.handler(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma, mailer, logger, llm: {} as any } as any,
    );
    // 1 sent (id=1), 1 retry (id=2), 1 permanent (id=3)
    expect(prisma.writes.filter((w) => /status = 'sent'/.test(w.sql))).toHaveLength(1);
    expect(prisma.writes.filter((w) => /next_retry_at = NOW\(\) \+/.test(w.sql))).toHaveLength(1);
    expect(prisma.writes.filter((w) => /status = 'failed_permanent'/.test(w.sql))).toHaveLength(1);
  });
});
