// Trigger: cron 0 * * * * (hourly).
// Owner: Time Entries module.
// Failure mode: retry 3x; non-blocking for the user.

import type { JobDefinition, JobDeps } from '../types';

export const timerStuckCleanup: JobDefinition = {
  name: 'time_entries.timer_stuck_cleanup',
  cron: '0 * * * *',
  trigger: 'cron',
  failureMode: 'retry 3x; failures logged but non-blocking.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const count = await deps.prisma.$executeRawUnsafe(
      `UPDATE time_entries
       SET status = 'draft', end_at = updated_at, notes = COALESCE(notes, '') || ' [abandoned by timer-stuck-cleanup]'
       WHERE status = 'running' AND updated_at < NOW() - INTERVAL '24 hours'`,
    );
    if (count > 0) deps.logger.warn('time_entries.timer_stuck_cleanup.closed_abandoned', { count });
  },
};
