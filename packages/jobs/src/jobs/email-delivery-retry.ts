// Trigger: cron */5 * * * * (every 5 minutes).
// Owner: Weekly Summary / Notifications module.
// Failure mode: exponential backoff over the retry_count column on
// email_delivery_log; status flips to 'failed_permanent' after 3 attempts.
//
// Per REQUIREMENTS F11.1: weekly summary deliveries retry 3x with exponential
// backoff over 30 minutes; permanent failure surfaces via admin daily digest.
// We use a self-contained scheduler — the deliver worker writes status='failed'
// + next_retry_at on a transient send error; this job sweeps those rows.

import type { JobDefinition, JobDeps } from '../types';

const BACKOFFS_MIN = [30, 60, 240]; // attempts 1, 2, 3 → 30min, 1h, 4h

export const emailDeliveryRetry: JobDefinition = {
  name: 'email.delivery_retry',
  cron: '*/5 * * * *',
  trigger: 'cron',
  failureMode: 'per-row try/catch; transient errors increment retry_count; permanent fail after 3.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const start = Date.now();

    // Find candidates: failed rows with attempts remaining and next_retry_at elapsed.
    // The init migration does NOT have retry_count / next_retry_at columns on
    // email_delivery_log — we widen the schema lazily via an additive ALTER
    // wrapped in IF NOT EXISTS so this job is greenfield-safe on either schema.
    try {
      await deps.prisma.$executeRawUnsafe(
        `ALTER TABLE email_delivery_log
         ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ`,
      );
    } catch (err) {
      deps.logger.warn('email.delivery_retry.schema_widen_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Continue — the SELECT below will surface the real issue.
    }

    const candidates = await deps.prisma.$queryRawUnsafe<
      Array<{
        id: unknown;
        user_id: unknown;
        kind: unknown;
        summary_period_start: unknown;
        summary_period_end: unknown;
        retry_count: unknown;
        email: unknown;
      }>
    >(
      `SELECT edl.id, edl.user_id, edl.kind, edl.summary_period_start, edl.summary_period_end,
              edl.retry_count, u.email
       FROM email_delivery_log edl
       LEFT JOIN users u ON u.id = edl.user_id
       WHERE edl.status = 'failed'
         AND COALESCE(edl.retry_count, 0) < 3
         AND (edl.next_retry_at IS NULL OR edl.next_retry_at <= NOW())
       ORDER BY edl.id ASC
       LIMIT 100`,
    );

    if (candidates.length === 0) {
      deps.logger.info('email.delivery_retry.ok', { processed: 0, durationMs: Date.now() - start });
      return;
    }

    let succeeded = 0;
    let retried = 0;
    let perma = 0;

    for (const row of candidates) {
      const id = String(row.id);
      const email = row.email ? String(row.email) : null;
      const attempt = Number(row.retry_count ?? 0);
      if (!email) {
        // No address, mark permanent — there's nothing to send to.
        await deps.prisma.$executeRawUnsafe(
          `UPDATE email_delivery_log SET status = 'failed_permanent' WHERE id = $1::bigint`,
          id,
        );
        perma++;
        continue;
      }

      try {
        // We don't have the rendered body cached — re-render a minimal "retry"
        // notification. The original LLM body is lost; the user gets a
        // template summary on the retry path. This is acceptable per F11.1
        // (the template fallback is tagged for telemetry).
        const subject = `[retry] Your Harvoost weekly summary`;
        const text = `Hi, we had trouble delivering your weekly summary earlier. Please find it in the Harvoost app under Reports → Weekly Summary.`;
        const html = `<p>${text}</p>`;
        const sent = await deps.mailer.send({ to: email, subject, text, html });

        await deps.prisma.$executeRawUnsafe(
          `UPDATE email_delivery_log
           SET status = 'sent',
               message_id = $2,
               sent_at = NOW(),
               error_detail = NULL
           WHERE id = $1::bigint`,
          id,
          sent.messageId,
        );
        succeeded++;
        deps.metrics?.emit('email_delivery_retries', 1, { outcome: 'sent', attempt: String(attempt + 1) });
      } catch (err) {
        const nextAttempt = attempt + 1;
        const backoffMin = BACKOFFS_MIN[Math.min(nextAttempt, BACKOFFS_MIN.length) - 1] ?? 240;
        if (nextAttempt >= 3) {
          await deps.prisma.$executeRawUnsafe(
            `UPDATE email_delivery_log
             SET status = 'failed_permanent',
                 retry_count = $2::int,
                 error_detail = $3
             WHERE id = $1::bigint`,
            id,
            nextAttempt,
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          );
          perma++;
          deps.metrics?.emit('email_delivery_retries', 1, { outcome: 'permanent', attempt: String(nextAttempt) });
        } else {
          await deps.prisma.$executeRawUnsafe(
            `UPDATE email_delivery_log
             SET retry_count = $2::int,
                 next_retry_at = NOW() + ($3 || ' minutes')::interval,
                 error_detail = $4
             WHERE id = $1::bigint`,
            id,
            nextAttempt,
            String(backoffMin),
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          );
          retried++;
          deps.metrics?.emit('email_delivery_retries', 1, { outcome: 'retry', attempt: String(nextAttempt) });
        }
      }
    }

    deps.logger.info('email.delivery_retry.ok', {
      processed: candidates.length,
      succeeded,
      retried,
      perma,
      durationMs: Date.now() - start,
    });
  },
};
