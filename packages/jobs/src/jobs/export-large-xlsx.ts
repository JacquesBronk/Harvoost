// Trigger: cron */1 * * * * (every minute) — drains pending export_jobs rows.
// Owner: Excel Export module.
// Failure mode: per-row try/catch; marks failed with error detail; no retry —
// the user submits a new export if the first fails (cheap UX, no permanent
// outstanding state).
//
// We don't import exceljs here directly because @harvoost/jobs is a pure
// catalogue package without app deps. Instead, the worker process injects a
// `xlsxRenderer` function via the JobDeps surface; apps/api wires it from
// XlsxWriterService.

import type { JobDefinition, JobDeps } from '../types';

export interface XlsxRendererInput {
  filter: {
    date_from: string;
    date_to: string;
    user_ids: string[] | null;
    project_ids: string[] | null;
  };
  actorUserId: string;
  jobId: string;
  // canSeeFinancial is derived from the actor's role at enqueue time and
  // persisted on the job row as part of the filter (we widen below).
  canSeeFinancial: boolean;
}

export interface XlsxRendererOutput {
  url: string;
  expiresAt: Date;
  rowCount: number;
}

export interface XlsxRenderer {
  // Renders + uploads + returns the SAS URL. The implementation lives in apps/api.
  render(input: XlsxRendererInput): Promise<XlsxRendererOutput>;
}

export const exportLargeXlsx: JobDefinition = {
  name: 'export.async_xlsx',
  cron: '* * * * *',
  trigger: 'cron',
  failureMode: 'per-job try/catch; marks failed with error detail.',
  handler: async (_payload: unknown, deps: JobDeps): Promise<void> => {
    const renderer = (deps as JobDeps & { xlsxRenderer?: XlsxRenderer }).xlsxRenderer;
    if (!renderer) {
      // The worker process didn't wire xlsxRenderer — log + skip; sync export
      // path is the load-bearing one. The dispatch documented this risk.
      deps.logger.warn('export.async_xlsx.no_renderer', {
        reason: 'xlsxRenderer not injected on JobDeps; large export queue idle',
      });
      return;
    }

    const pending = await deps.prisma.$queryRawUnsafe<
      Array<{ id: unknown; actor_user_id: unknown; filter: unknown }>
    >(
      `SELECT id, actor_user_id, filter
       FROM export_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 5`,
    );
    if (pending.length === 0) return;

    for (const row of pending) {
      const jobId = String(row.id);
      const actorUserId = String(row.actor_user_id);
      let filter: XlsxRendererInput['filter'];
      let canSeeFinancial = false;
      try {
        const parsed = typeof row.filter === 'string'
          ? JSON.parse(row.filter)
          : (row.filter as Record<string, unknown>);
        filter = {
          date_from: String(parsed.date_from),
          date_to: String(parsed.date_to),
          user_ids: Array.isArray(parsed.user_ids)
            ? (parsed.user_ids as unknown[]).map(String)
            : null,
          project_ids: Array.isArray(parsed.project_ids)
            ? (parsed.project_ids as unknown[]).map(String)
            : null,
        };
        canSeeFinancial = Boolean(
          (parsed as { _can_see_financial?: boolean })._can_see_financial,
        );
      } catch (err) {
        await markFailed(deps, jobId, `bad filter payload: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      try {
        await deps.prisma.$executeRawUnsafe(
          `UPDATE export_jobs SET status='running', updated_at=NOW() WHERE id = $1::uuid`,
          jobId,
        );
        const out = await renderer.render({ filter, actorUserId, jobId, canSeeFinancial });
        await deps.prisma.$executeRawUnsafe(
          `UPDATE export_jobs SET status='done', download_url=$2, expires_at=$3, updated_at=NOW()
           WHERE id = $1::uuid`,
          jobId,
          out.url,
          out.expiresAt.toISOString(),
        );
        deps.logger.info('export.async_xlsx.ok', { jobId, rowCount: out.rowCount });
      } catch (err) {
        await markFailed(deps, jobId, err instanceof Error ? err.message : String(err));
      }
    }
  },
};

async function markFailed(deps: JobDeps, jobId: string, msg: string): Promise<void> {
  try {
    await deps.prisma.$executeRawUnsafe(
      `UPDATE export_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id = $1::uuid`,
      jobId,
      msg.slice(0, 1000),
    );
  } catch {
    // ignore — surface via logger
  }
  deps.logger.error('export.async_xlsx.failed', { jobId, msg });
}
