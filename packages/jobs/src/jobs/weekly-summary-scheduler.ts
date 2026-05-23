// Trigger: cron */15 * * * * (every 15 minutes).
// Owner: Weekly Summary module.
// Failure mode: idempotent — duplicate enqueue prevented by uniqueness on email_delivery_log(user_id, summary_period_start).
//
// For each user not opted out: if Monday-08:00-in-their-TZ has arrived this iso-week
// and no delivery row exists for it, enqueue `summary.deliver_user` at that exact UTC.

import { DateTime } from 'luxon';
import { nextWeekdayAt, weekRange } from '@harvoost/shared';
import type { JobDefinition, JobDeps } from '../types';

export const weeklySummaryScheduler: JobDefinition = {
  name: 'summary.weekly_scheduler',
  cron: '*/15 * * * *',
  trigger: 'cron',
  failureMode: 'idempotent; relies on email_delivery_log uniqueness to prevent duplicates.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const start = Date.now();
    const now = DateTime.utc();
    const users = await deps.prisma.$queryRawUnsafe<
      Array<{ id: unknown; timezone: unknown; email: unknown }>
    >(
      `SELECT id, timezone, email FROM users
       WHERE is_active = TRUE AND weekly_summary_opt_out = FALSE`,
    );
    let scheduled = 0;
    for (const u of users) {
      const tz = String(u.timezone);
      const userId = String(u.id);
      // Find the most recent Monday 08:00 local that has already passed (i.e. the start of THIS week's summary window).
      const nextMondayUtc = nextWeekdayAt(1, 8, 0, tz, now);
      // The current iso-week's summary instant is the most-recent past one — derive by subtracting 7 days from nextMonday.
      const lastMondayUtc = nextMondayUtc.minus({ weeks: 1 });
      if (lastMondayUtc > now) continue; // hasn't arrived yet
      // Compute summary period: prior Mon..Sun in user's TZ.
      const periodLocal = weekRange(lastMondayUtc.minus({ days: 1 }), tz, 1);
      const periodStart = periodLocal.startLocal.toISODate();
      // Skip if a delivery already exists for this period.
      const existing = await deps.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
        `SELECT id FROM email_delivery_log
         WHERE user_id = $1::bigint AND summary_period_start = $2::date AND kind = 'weekly_summary'
         LIMIT 1`,
        userId,
        periodStart,
      );
      if (existing.length > 0) continue;
      // Enqueue placeholder row — the deliver worker will update status on send.
      // TODO(build-phase-followup): write to pg-boss queue with start_after = lastMondayUtc.
      await deps.prisma.$executeRawUnsafe(
        `INSERT INTO email_delivery_log (user_id, kind, summary_period_start, summary_period_end, status, created_at)
         VALUES ($1::bigint, 'weekly_summary', $2::date, $3::date, 'queued', NOW())
         ON CONFLICT DO NOTHING`,
        userId,
        periodStart,
        periodLocal.endLocalExclusive.minus({ days: 1 }).toISODate(),
      );
      scheduled++;
    }
    deps.logger.info('summary.weekly_scheduler.ok', { scheduled, durationMs: Date.now() - start });
  },
};
