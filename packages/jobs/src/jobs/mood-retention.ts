// Trigger: cron 0 3 * * * (daily 03:30 UTC — staggered from chatbot prune by 30 min).
// Owner: Mood module.
// Failure mode: retry 3x; alert if no successful run in 36h (REQUIREMENTS § Risks).
//
// For every mood_entries row older than 90 days:
//   - For each (anchor, iso_year, iso_week) bucket the user contributed to, upsert into
//     mood_weekly_aggregates only if sample_size >= 5 (k-anonymity enforced at write time).
//   - Delete the raw row regardless (per the 90-day promise).
//
// The anchor strings follow the architecture convention: `proj:<id>` or `mgr:<id>`.

import type { JobDefinition, JobDeps } from '../types';

export const moodRetention: JobDefinition = {
  name: 'mood.retention_job',
  cron: '30 3 * * *',
  trigger: 'cron',
  failureMode: 'retry 3x with backoff; AppInsights alert if no successful run in 36h.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const start = Date.now();
    // Step 1: upsert weekly aggregates for project anchors at k>=5.
    await deps.prisma.$executeRawUnsafe(
      `INSERT INTO mood_weekly_aggregates (team_anchor, iso_year, iso_week, sample_size, score_avg, score_stdev)
       SELECT 'proj:' || pm.project_id::text AS team_anchor,
              EXTRACT(ISOYEAR FROM me.local_date)::int AS iso_year,
              EXTRACT(WEEK FROM me.local_date)::int AS iso_week,
              COUNT(DISTINCT me.user_id) AS sample_size,
              AVG(me.score)::numeric(3,2) AS score_avg,
              STDDEV_POP(me.score)::numeric(3,2) AS score_stdev
       FROM mood_entries me
       JOIN project_members pm ON pm.user_id = me.user_id AND pm.left_at IS NULL
       WHERE me.created_at < NOW() - INTERVAL '90 days'
       GROUP BY 1, 2, 3
       HAVING COUNT(DISTINCT me.user_id) >= 5
       ON CONFLICT (team_anchor, iso_year, iso_week) DO NOTHING`,
    );

    // Step 2: same for manager anchors.
    await deps.prisma.$executeRawUnsafe(
      `INSERT INTO mood_weekly_aggregates (team_anchor, iso_year, iso_week, sample_size, score_avg, score_stdev)
       SELECT 'mgr:' || um.manager_id::text AS team_anchor,
              EXTRACT(ISOYEAR FROM me.local_date)::int AS iso_year,
              EXTRACT(WEEK FROM me.local_date)::int AS iso_week,
              COUNT(DISTINCT me.user_id) AS sample_size,
              AVG(me.score)::numeric(3,2) AS score_avg,
              STDDEV_POP(me.score)::numeric(3,2) AS score_stdev
       FROM mood_entries me
       JOIN user_managers um ON um.user_id = me.user_id
       WHERE me.created_at < NOW() - INTERVAL '90 days'
       GROUP BY 1, 2, 3
       HAVING COUNT(DISTINCT me.user_id) >= 5
       ON CONFLICT (team_anchor, iso_year, iso_week) DO NOTHING`,
    );

    // Step 3: delete the raw rows. This is non-recoverable.
    const deleted = await deps.prisma.$executeRawUnsafe(
      `DELETE FROM mood_entries WHERE created_at < NOW() - INTERVAL '90 days'`,
    );

    deps.logger.info('mood.retention_job.ok', {
      rawDeleted: deleted,
      durationMs: Date.now() - start,
    });
  },
};
