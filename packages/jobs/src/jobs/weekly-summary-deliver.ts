// Trigger: enqueued by the scheduler at next-Monday-08:00-local UTC instant.
// Owner: Weekly Summary module.
// Failure mode: 3 retries over 30 min; permanent failure → record + admin daily digest.
//
// Generates per-employee summary (LLM via LLMProvider, deterministic fallback on error),
// sends via mailer, logs delivery. Per F11.1 the email body is LLM-rendered prose with
// a template fallback that is tagged `[fallback summary]` for telemetry.

import { pickQuote } from '../quotes';
import type { JobDefinition, JobDeps } from '../types';

interface DeliverPayload {
  userId: string;
  periodStart: string;
  periodEnd: string;
}

export const weeklySummaryDeliver: JobDefinition = {
  name: 'summary.deliver_user',
  trigger: 'event',
  failureMode: '3 retries over 30 min; permanent failure → admin daily digest.',
  handler: async (payload: unknown, deps: JobDeps): Promise<void> => {
    const p = payload as DeliverPayload;
    const user = await deps.prisma.$queryRawUnsafe<Array<{ email: unknown; display_name: unknown; timezone: unknown }>>(
      `SELECT email, display_name, timezone FROM users WHERE id = $1::bigint AND is_active = TRUE`,
      p.userId,
    );
    if (user.length === 0) {
      deps.logger.warn('summary.deliver_user.user_missing', { userId: p.userId });
      return;
    }
    const email = String(user[0]!.email);
    const displayName = String(user[0]!.display_name);

    // Rollup data — total hours, top 3 projects, own mood-average.
    const totals = await deps.prisma.$queryRawUnsafe<Array<{ total_hours: unknown }>>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 3600.0), 0) AS total_hours
       FROM time_entries
       WHERE user_id = $1::bigint AND end_at IS NOT NULL
         AND start_at >= $2::date AND start_at < ($3::date + INTERVAL '1 day')`,
      p.userId,
      p.periodStart,
      p.periodEnd,
    );
    const topProjects = await deps.prisma.$queryRawUnsafe<Array<{ name: unknown; hours: unknown }>>(
      `SELECT p.name, SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) AS hours
       FROM time_entries te
       JOIN projects p ON p.id = te.project_id
       WHERE te.user_id = $1::bigint AND te.end_at IS NOT NULL
         AND te.start_at >= $2::date AND te.start_at < ($3::date + INTERVAL '1 day')
       GROUP BY p.name ORDER BY hours DESC LIMIT 3`,
      p.userId,
      p.periodStart,
      p.periodEnd,
    );

    const totalHours = Number(totals[0]?.total_hours ?? 0);
    const projects = topProjects.map((r) => ({ name: String(r.name), hours: Number(r.hours ?? 0) }));
    const quote = pickQuote(`${p.userId}:${p.periodStart}`);

    let body: string;
    let mode: 'llm' | 'template' = 'llm';
    try {
      const prompt = `Write a brief (3-4 sentence), warm Monday-morning summary email for ${displayName}. They logged ${totalHours.toFixed(1)} hours last week. Top projects: ${projects.map((pp) => `${pp.name} (${pp.hours.toFixed(1)}h)`).join(', ') || 'no projects logged'}.`;
      const result = await deps.llm.generateText({
        system: 'You are a friendly internal HR comms writer. Keep it warm, brief, and professional. No emojis. No salutations like "Dear" — just the body.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 256,
      });
      body = result.text;
    } catch (err) {
      mode = 'template';
      body = renderTemplate(displayName, totalHours, projects);
      deps.logger.warn('summary.deliver_user.llm_fallback', {
        userId: p.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const fullText = `${mode === 'template' ? '[fallback summary] ' : ''}${body}\n\n"${quote.text}" — ${quote.author}`;
    const html = `<p>${escapeHtml(body)}</p><blockquote>"${escapeHtml(quote.text)}" — ${escapeHtml(quote.author)}</blockquote>`;
    const subject = `Your Harvoost week — ${p.periodStart} to ${p.periodEnd}`;

    try {
      const sent = await deps.mailer.send({ to: email, subject, html, text: fullText });
      await deps.prisma.$executeRawUnsafe(
        `UPDATE email_delivery_log
         SET status = 'sent', mode = $4, message_id = $5, sent_at = NOW()
         WHERE user_id = $1::bigint AND kind = 'weekly_summary' AND summary_period_start = $2::date AND summary_period_end = $3::date`,
        p.userId,
        p.periodStart,
        p.periodEnd,
        mode,
        sent.messageId,
      );
      deps.logger.info('summary.deliver_user.ok', { userId: p.userId, mode });
    } catch (err) {
      await deps.prisma.$executeRawUnsafe(
        `UPDATE email_delivery_log
         SET status = 'failed', mode = $4, error_detail = $5
         WHERE user_id = $1::bigint AND kind = 'weekly_summary' AND summary_period_start = $2::date AND summary_period_end = $3::date`,
        p.userId,
        p.periodStart,
        p.periodEnd,
        mode,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  },
};

function renderTemplate(name: string, total: number, projects: { name: string; hours: number }[]): string {
  if (total === 0) {
    return `Hi ${name}, you didn't log any hours last week — was that intentional? Reply or chat to your manager if you need help.`;
  }
  const top = projects.length === 0 ? 'no projects logged' : projects.map((p) => `${p.name} (${p.hours.toFixed(1)}h)`).join(', ');
  return `Hi ${name}, last week you logged ${total.toFixed(1)} hours, mostly on ${top}. Have a great week ahead!`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
