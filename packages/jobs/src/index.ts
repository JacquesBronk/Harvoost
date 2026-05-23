// @harvoost/jobs — pg-boss job catalogue.
//
// Public surface: registerJobs(boss, deps) wires every job into pg-boss with its
// declared schedule/trigger. apps/api boots a worker process that calls this on startup
// when WORKER_MODE=1.

import { chatbotPruneOldConversations } from './jobs/chatbot-prune-old-conversations';
import { moodRetention } from './jobs/mood-retention';
import { exceptionDetection } from './jobs/exception-detection';
import { overtimeRealtime } from './jobs/overtime-realtime';
import { weeklySummaryScheduler } from './jobs/weekly-summary-scheduler';
import { weeklySummaryDeliver } from './jobs/weekly-summary-deliver';
import { auditLogIntegrity } from './jobs/audit-log-integrity';
import { exportLargeXlsx } from './jobs/export-large-xlsx';
import { emailDeliveryRetry } from './jobs/email-delivery-retry';
import { timerStuckCleanup } from './jobs/timer-stuck-cleanup';
import { bambooSyncStub } from './jobs/bamboo-sync-stub';
import { seedMotivationalQuotes } from './jobs/seed-motivational-quotes';
import type { JobDefinition, JobDeps } from './types';

export const ALL_JOBS: ReadonlyArray<JobDefinition> = [
  chatbotPruneOldConversations,
  moodRetention,
  exceptionDetection,
  overtimeRealtime,
  weeklySummaryScheduler,
  weeklySummaryDeliver,
  auditLogIntegrity,
  exportLargeXlsx,
  emailDeliveryRetry,
  timerStuckCleanup,
  bambooSyncStub,
  seedMotivationalQuotes,
];

// Minimal pg-boss surface (the actual library exposes more).
export interface PgBossLike {
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<string | null>;
  work(name: string, handler: (job: { data: unknown }) => Promise<void>): Promise<string>;
}

export async function registerJobs(boss: PgBossLike, deps: JobDeps): Promise<void> {
  for (const job of ALL_JOBS) {
    // Wire the worker for the queue (event-driven jobs use this exclusively;
    // cron jobs also need a worker registered to consume the cron-emitted jobs).
    await boss.work(job.name, async (j) => {
      try {
        await job.handler(j.data, deps);
      } catch (err) {
        deps.logger.error(`${job.name}.error`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    // Schedule cron triggers.
    if (job.cron) {
      await boss.schedule(job.name, job.cron);
      deps.logger.info('job.scheduled', { name: job.name, cron: job.cron });
    } else {
      deps.logger.info('job.registered', { name: job.name, trigger: job.trigger });
    }
  }
}

export type { JobDefinition, JobDeps, JobsPrismaLike, Mailer, JobsLogger } from './types';
export { MOTIVATIONAL_QUOTES, pickQuote } from './quotes';

// Named re-exports so unit tests can import individual jobs without depending
// on the catalogue's index ordering.
export { chatbotPruneOldConversations } from './jobs/chatbot-prune-old-conversations';
export { moodRetention } from './jobs/mood-retention';
export { exceptionDetection } from './jobs/exception-detection';
export { overtimeRealtime } from './jobs/overtime-realtime';
export { weeklySummaryScheduler } from './jobs/weekly-summary-scheduler';
export { weeklySummaryDeliver } from './jobs/weekly-summary-deliver';
export { auditLogIntegrity } from './jobs/audit-log-integrity';
export { exportLargeXlsx } from './jobs/export-large-xlsx';
export { emailDeliveryRetry } from './jobs/email-delivery-retry';
export { timerStuckCleanup } from './jobs/timer-stuck-cleanup';
export { bambooSyncStub } from './jobs/bamboo-sync-stub';
export { seedMotivationalQuotes } from './jobs/seed-motivational-quotes';
