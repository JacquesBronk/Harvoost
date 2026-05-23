// Trigger: cron 0 2 * * * (daily 02:00 UTC).
// Owner: Exceptions module.
// Failure mode: retry 3x; partial completion is OK (per-user idempotent via UNIQUE constraint).
//
// Detects exception types for the prior calendar day in the user's local TZ:
//   1. MISSED_PUNCH    — no time entries AND no approved leave on a scheduled working day.
//   2. OVERTIME_DAY    — > OT_DAY_THRESHOLD_HOURS on that day (env-configurable, default 10).
//   3. OVERTIME_WEEK   — > OT_WEEK_THRESHOLD_HOURS on the trailing 7-day rolling sum
//                        (env-configurable, default 50).
//   4. ANOMALY_LOW/HIGH — daily hours differ from trailing 4-week mean by > N*stdev
//                        (env-configurable via ANOMALY_STDEV_THRESHOLD, default 2.0).
//                        Suppressed when stdev <= 0.1 to avoid noise for consistent loggers.
//
// All exception inserts are idempotent via UNIQUE (user_id, exception_type, local_date).

import type { JobDefinition, JobDeps } from '../types';

function readNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const exceptionDetection: JobDefinition = {
  name: 'exception.nightly_batch',
  cron: '0 2 * * *',
  trigger: 'cron',
  failureMode:
    'retry 3x with exponential backoff; on persistent fail, AppInsights alert + admin email.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const start = Date.now();
    const otDayThreshold = readNum('OT_DAY_THRESHOLD_HOURS', 10);
    const otWeekThreshold = readNum('OT_WEEK_THRESHOLD_HOURS', 50);
    const anomalySigma = readNum('ANOMALY_STDEV_THRESHOLD', 2.0);

    // ----- 1. MISSED_PUNCH ---------------------------------------------------
    await deps.prisma.$executeRawUnsafe(
      `INSERT INTO exceptions (user_id, exception_type, local_date, details, status)
       SELECT u.id,
              'MISSED_PUNCH',
              (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date,
              jsonb_build_object('reason', 'no_entries_no_leave'),
              'open'
       FROM users u
       JOIN schedule_templates st ON st.user_id = u.id
       WHERE u.is_active = TRUE
         AND EXTRACT(ISODOW FROM (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day'))::int = ANY(st.working_days)
         AND NOT EXISTS (
           SELECT 1 FROM time_entries te
           WHERE te.user_id = u.id
             AND te.start_at >= (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date
             AND te.start_at < (NOW() AT TIME ZONE u.timezone)::date
         )
         AND NOT EXISTS (
           SELECT 1 FROM leave_requests lr
           WHERE lr.user_id = u.id
             AND lr.status = 'approved'
             AND (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date BETWEEN lr.start_date AND lr.end_date
         )
       ON CONFLICT (user_id, exception_type, local_date) DO NOTHING`,
    );

    // ----- 2. OVERTIME_DAY ---------------------------------------------------
    // Per REQUIREMENTS F8.2: thresholds are env-configurable. We pass the
    // threshold as a bind parameter so the SQL plan caches cleanly.
    await deps.prisma.$executeRawUnsafe(
      `INSERT INTO exceptions (user_id, exception_type, local_date, details, status)
       SELECT te.user_id,
              'OVERTIME_DAY',
              (te.start_at AT TIME ZONE u.timezone)::date,
              jsonb_build_object(
                'observed_hours', SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0),
                'threshold', $1::numeric
              ),
              'open'
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.end_at IS NOT NULL
         AND (te.start_at AT TIME ZONE u.timezone)::date = (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date
       GROUP BY te.user_id, u.timezone, (te.start_at AT TIME ZONE u.timezone)::date
       HAVING SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) > $1::numeric
       ON CONFLICT (user_id, exception_type, local_date) DO NOTHING`,
      otDayThreshold,
    );

    // ----- 3. OVERTIME_WEEK (Item 5) ----------------------------------------
    // Sum each user's hours over the trailing 7 calendar days IN their LOCAL TZ.
    // local_date is anchored to the week-ending day (yesterday in the user's TZ).
    await deps.prisma.$executeRawUnsafe(
      `INSERT INTO exceptions (user_id, exception_type, local_date, details, status)
       SELECT u.id,
              'OVERTIME_WEEK',
              (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date AS week_end_date,
              jsonb_build_object(
                'observed_hours', SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0),
                'threshold', $1::numeric,
                'window', '7d_rolling',
                'window_end_local', (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date
              ),
              'open'
       FROM users u
       JOIN time_entries te ON te.user_id = u.id
       WHERE u.is_active = TRUE
         AND te.end_at IS NOT NULL
         AND (te.start_at AT TIME ZONE u.timezone)::date
             BETWEEN (NOW() AT TIME ZONE u.timezone - INTERVAL '7 days')::date
                 AND (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date
       GROUP BY u.id, u.timezone
       HAVING SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) > $1::numeric
       ON CONFLICT (user_id, exception_type, local_date) DO NOTHING`,
      otWeekThreshold,
    );

    // ----- 4. ANOMALY_LOW / ANOMALY_HIGH (Item 6) ---------------------------
    // Compute mean + stdev of daily hours across the trailing 4 calendar weeks
    // (28 calendar days), restricted to the user's working days from
    // schedule_templates.working_days (default Mon-Fri per F7.1). Flag the
    // most recent local-day if abs(hours - mean) > anomalySigma * stdev AND
    // stdev > 0.1 (suppresses noise for consistent loggers).
    //
    // We use a CTE per user-day; the final INSERT writes ANOMALY_LOW when the
    // current-day total is below mean by >Nσ, else ANOMALY_HIGH when above.
    await deps.prisma.$executeRawUnsafe(
      `WITH daily AS (
         SELECT te.user_id,
                u.timezone,
                (te.start_at AT TIME ZONE u.timezone)::date AS local_day,
                SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) AS hours
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         JOIN schedule_templates st ON st.user_id = u.id
         WHERE u.is_active = TRUE
           AND te.end_at IS NOT NULL
           AND (te.start_at AT TIME ZONE u.timezone)::date
               >= (NOW() AT TIME ZONE u.timezone - INTERVAL '28 days')::date
           AND (te.start_at AT TIME ZONE u.timezone)::date
               <= (NOW() AT TIME ZONE u.timezone - INTERVAL '1 day')::date
           AND EXTRACT(ISODOW FROM (te.start_at AT TIME ZONE u.timezone))::int = ANY(st.working_days)
         GROUP BY te.user_id, u.timezone, (te.start_at AT TIME ZONE u.timezone)::date
       ),
       stats AS (
         SELECT user_id, timezone,
                AVG(hours)::numeric(10,4)   AS mean_h,
                STDDEV_POP(hours)::numeric(10,4) AS std_h
         FROM daily
         GROUP BY user_id, timezone
       ),
       yesterday AS (
         SELECT d.user_id, d.local_day, d.hours, s.mean_h, s.std_h
         FROM daily d
         JOIN stats s ON s.user_id = d.user_id
         WHERE d.local_day = (NOW() AT TIME ZONE d.timezone - INTERVAL '1 day')::date
       )
       INSERT INTO exceptions (user_id, exception_type, local_date, details, status)
       SELECT user_id,
              CASE WHEN hours < mean_h THEN 'ANOMALY_LOW' ELSE 'ANOMALY_HIGH' END,
              local_day,
              jsonb_build_object(
                'observed_hours', hours,
                'mean_hours', mean_h,
                'stdev_hours', std_h,
                'sigma_threshold', $1::numeric,
                'window_days', 28
              ),
              'open'
       FROM yesterday
       WHERE std_h > 0.1
         AND ABS(hours - mean_h) > $1::numeric * std_h
       ON CONFLICT (user_id, exception_type, local_date) DO NOTHING`,
      anomalySigma,
    );

    deps.logger.info('exception.nightly_batch.ok', {
      durationMs: Date.now() - start,
      otDayThreshold,
      otWeekThreshold,
      anomalySigma,
    });
  },
};
