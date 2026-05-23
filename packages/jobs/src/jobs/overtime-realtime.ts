// Trigger: cron */1 * * * * (every 1 minute) — drains the overtime_realtime_queue
// side-channel table populated by time-entries.controller stop/switch handlers.
// Each pending row triggers a single-user OT_DAY/OT_WEEK recompute scoped to the
// user's local-TZ calendar day. De-dups against the nightly batch via the
// UNIQUE (user_id, exception_type, local_date) constraint.
//
// Owner: Exceptions module.
// Failure mode: per-user errors logged; queue row remains pending for the next run
// (which acts as the retry mechanism — pg-boss-style retries here would require
// payload-per-job; we chose a simpler queue-table to keep apps/api free of boss).

import type { JobDefinition, JobDeps } from '../types';

function readNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const overtimeRealtime: JobDefinition = {
  name: 'exception.realtime_overtime_check',
  cron: '* * * * *',
  trigger: 'cron',
  failureMode: 'per-user errors logged; queue row stays pending so next minute retries.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const otDay = readNum('OT_DAY_THRESHOLD_HOURS', 10);
    const otWeek = readNum('OT_WEEK_THRESHOLD_HOURS', 50);

    // Drain at most 100 queued users per run. Higher batches risk lock contention
    // on time_entries; 100 is plenty since each user produces at most 2 rows.
    const queued = await deps.prisma.$queryRawUnsafe<Array<{ user_id: unknown }>>(
      `DELETE FROM overtime_realtime_queue
       WHERE user_id IN (
         SELECT user_id FROM overtime_realtime_queue
         ORDER BY enqueued_at ASC LIMIT 100
       )
       RETURNING user_id`,
    );

    if (queued.length === 0) return;

    for (const row of queued) {
      const userId = String(row.user_id);
      try {
        // OVERTIME_DAY for today (in user's local TZ).
        await deps.prisma.$executeRawUnsafe(
          `INSERT INTO exceptions (user_id, exception_type, local_date, details, status)
           SELECT te.user_id,
                  'OVERTIME_DAY',
                  (te.start_at AT TIME ZONE u.timezone)::date,
                  jsonb_build_object(
                    'observed_hours', SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0),
                    'threshold', $2::numeric,
                    'source', 'realtime'
                  ),
                  'open'
           FROM time_entries te
           JOIN users u ON u.id = te.user_id
           WHERE te.user_id = $1::bigint
             AND te.end_at IS NOT NULL
             AND (te.start_at AT TIME ZONE u.timezone)::date = (NOW() AT TIME ZONE u.timezone)::date
           GROUP BY te.user_id, u.timezone, (te.start_at AT TIME ZONE u.timezone)::date
           HAVING SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) > $2::numeric
           ON CONFLICT (user_id, exception_type, local_date) DO NOTHING`,
          userId,
          otDay,
        );

        // OVERTIME_WEEK trailing 7 days (ending today in user's local TZ).
        await deps.prisma.$executeRawUnsafe(
          `INSERT INTO exceptions (user_id, exception_type, local_date, details, status)
           SELECT u.id,
                  'OVERTIME_WEEK',
                  (NOW() AT TIME ZONE u.timezone)::date,
                  jsonb_build_object(
                    'observed_hours', SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0),
                    'threshold', $2::numeric,
                    'window', '7d_rolling',
                    'source', 'realtime'
                  ),
                  'open'
           FROM users u
           JOIN time_entries te ON te.user_id = u.id
           WHERE u.id = $1::bigint
             AND te.end_at IS NOT NULL
             AND (te.start_at AT TIME ZONE u.timezone)::date
                 BETWEEN (NOW() AT TIME ZONE u.timezone - INTERVAL '6 days')::date
                     AND (NOW() AT TIME ZONE u.timezone)::date
           GROUP BY u.id, u.timezone
           HAVING SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) > $2::numeric
           ON CONFLICT (user_id, exception_type, local_date) DO NOTHING`,
          userId,
          otWeek,
        );
      } catch (err) {
        deps.logger.error('exception.realtime_overtime_check.user_failed', {
          userId,
          err: err instanceof Error ? err.message : String(err),
        });
        // Re-enqueue so the next tick retries (preserves the queue contract).
        try {
          await deps.prisma.$executeRawUnsafe(
            `INSERT INTO overtime_realtime_queue (user_id, enqueued_at)
             VALUES ($1::bigint, NOW())
             ON CONFLICT (user_id) DO UPDATE SET enqueued_at = NOW()`,
            userId,
          );
        } catch {
          // Best-effort.
        }
      }
    }

    deps.logger.info('exception.realtime_overtime_check.ok', {
      drained: queued.length,
      otDay,
      otWeek,
    });
  },
};
