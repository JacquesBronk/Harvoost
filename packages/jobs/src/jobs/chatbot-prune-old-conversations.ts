// Trigger: cron 0 3 * * * (daily 03:00 UTC).
// Owner: Chatbot module.
// Failure mode: retry 2x; alert if no successful run in 48h. Idempotent — re-running mid-day
//   simply deletes any newly-aged-out rows. chatbot_messages cascade-delete via FK.
//
// Implements ARCHITECTURE.md r2 § "Persistence + retention".

import type { JobDefinition, JobDeps } from '../types';

export const chatbotPruneOldConversations: JobDefinition = {
  name: 'chatbot.prune_old_conversations',
  cron: '0 3 * * *',
  trigger: 'cron',
  failureMode: 'retry 2x with backoff; AppInsights alert if no successful run in 48h.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const start = Date.now();
    // Parameterized — no string interpolation for the threshold.
    const count = await deps.prisma.$executeRawUnsafe(
      `DELETE FROM chatbot_conversations
       WHERE last_message_at < NOW() - INTERVAL '30 days'`,
    );
    deps.logger.info('chatbot.prune_old_conversations.ok', {
      deletedConversations: count,
      durationMs: Date.now() - start,
    });
  },
};
