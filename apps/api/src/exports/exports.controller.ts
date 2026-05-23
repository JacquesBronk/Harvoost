import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { columnsForRole } from '@harvoost/shared';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { RbacScopeService } from '@harvoost/shared';
import { XlsxWriterService, type XlsxRow } from './xlsx-writer.service';
import { ExportJobsService } from './export-jobs.service';

const ExportSchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  project_ids: z.array(z.string().regex(/^\d+$/)).optional(),
  user_ids: z.array(z.string().regex(/^\d+$/)).optional(),
});

// Threshold per REQUIREMENTS F9.3 — ≤100k rows sync; >100k async.
const SYNC_THRESHOLD = 100_000;

@Controller('v1/exports')
export class ExportsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
    private readonly writer: XlsxWriterService,
    private readonly jobs: ExportJobsService,
  ) {}

  @Post('excel')
  async excel(
    @CurrentUser() user: CurrentUserPayload,
    @Body(new ZodValidationPipe(ExportSchema)) body: z.infer<typeof ExportSchema>,
  ) {
    const canSeeFinancial = user.roles.includes('admin') || user.roles.includes('finmgr');

    // SECURITY M10: intersect caller-supplied user_ids/project_ids with RBAC scope.
    const filter = await this.intersectFilter(user, body);

    // Cheap COUNT first — gates the sync/async branch.
    const countParams: unknown[] = [filter.date_from, filter.date_to];
    const countWheres: string[] = [
      `te.start_at >= $1::date`,
      `te.start_at < ($2::date + INTERVAL '1 day')`,
      `te.end_at IS NOT NULL`,
    ];
    if (filter.user_ids) {
      countParams.push(filter.user_ids);
      countWheres.push(`te.user_id = ANY($${countParams.length}::bigint[])`);
    }
    if (filter.project_ids) {
      countParams.push(filter.project_ids);
      countWheres.push(`te.project_id = ANY($${countParams.length}::bigint[])`);
    }
    const countRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*)::bigint AS n FROM time_entries te WHERE ${countWheres.join(' AND ')}`,
      ...countParams,
    );
    const rowCount = Number(countRows[0]?.n ?? 0);

    if (rowCount > SYNC_THRESHOLD) {
      // Async path — enqueue a job and return its id.
      const job = await this.jobs.create(user.userId, filter);
      return {
        mode: 'async' as const,
        job_id: job.jobId,
        status: 'queued' as const,
        row_count: rowCount,
        threshold: SYNC_THRESHOLD,
      };
    }

    // Synchronous path — generate, upload, return URL.
    const rows = await this.fetchRows(filter, canSeeFinancial);
    const buffer = await this.writer.writeBuffer(rows, canSeeFinancial);
    const fileName = `${randomUUID()}.xlsx`;
    const upload = await this.jobs.uploadAndSign(user.userId, fileName, buffer);

    return {
      mode: 'sync' as const,
      download_url: upload.url,
      expires_at: upload.expiresAt.toISOString(),
      row_count: rowCount,
      columns: columnsForRole(canSeeFinancial).map((c) => c.header),
      filters: filter,
    };
  }

  // GET /v1/exports/jobs/:job_id — poll for async export status.
  // RBAC: actor must own the job. The download URL itself is the security
  // boundary (SAS, short TTL), so the actual download is unauthenticated.
  @Get('jobs/:id')
  async jobStatus(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    const job = await this.jobs.get(id, user.userId);
    if (!job) throw new NotFoundException('Export job not found');
    return {
      job_id: job.id,
      status: job.status,
      download_url: job.download_url,
      expires_at: job.expires_at,
      error: job.error,
      created_at: job.created_at,
      updated_at: job.updated_at,
    };
  }

  // ---- internals -----------------------------------------------------------

  private async intersectFilter(
    user: CurrentUserPayload,
    body: z.infer<typeof ExportSchema>,
  ): Promise<{
    date_from: string;
    date_to: string;
    user_ids: string[] | null;
    project_ids: string[] | null;
  }> {
    const vu = await this.rbac.getVisibleUserIds(user.userId);
    const vp = await this.rbac.getVisibleProjectIds(user.userId);
    const visibleUserIds = vu.unrestricted ? null : new Set(vu.userIds);
    const visibleProjectIds = vp.unrestricted ? null : new Set(vp.projectIds);

    let userIds: string[] | null;
    if (body.user_ids && body.user_ids.length > 0) {
      userIds = visibleUserIds
        ? body.user_ids.filter((u) => visibleUserIds.has(u))
        : body.user_ids;
    } else {
      userIds = visibleUserIds ? Array.from(visibleUserIds) : null;
    }

    let projectIds: string[] | null;
    if (body.project_ids && body.project_ids.length > 0) {
      projectIds = visibleProjectIds
        ? body.project_ids.filter((p) => visibleProjectIds.has(p))
        : body.project_ids;
    } else {
      projectIds = visibleProjectIds ? Array.from(visibleProjectIds) : null;
    }

    return {
      date_from: body.date_from,
      date_to: body.date_to,
      user_ids: userIds && userIds.length > 0 ? userIds : userIds,
      project_ids: projectIds && projectIds.length > 0 ? projectIds : projectIds,
    };
  }

  private async fetchRows(
    filter: {
      date_from: string;
      date_to: string;
      user_ids: string[] | null;
      project_ids: string[] | null;
    },
    canSeeFinancial: boolean,
  ): Promise<XlsxRow[]> {
    const params: unknown[] = [filter.date_from, filter.date_to];
    const wheres: string[] = [
      `te.start_at >= $1::date`,
      `te.start_at < ($2::date + INTERVAL '1 day')`,
      `te.end_at IS NOT NULL`,
    ];
    if (filter.user_ids) {
      params.push(filter.user_ids);
      wheres.push(`te.user_id = ANY($${params.length}::bigint[])`);
    }
    if (filter.project_ids) {
      params.push(filter.project_ids);
      wheres.push(`te.project_id = ANY($${params.length}::bigint[])`);
    }

    // Pull data with the columns Harvest expects. Cost fields are pulled
    // unconditionally and stripped in the writer via columnsForRole().
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        date: unknown;
        client: unknown;
        project: unknown;
        project_code: unknown;
        task: unknown;
        notes: unknown;
        hours: unknown;
        billable: unknown;
        first_name: unknown;
        last_name: unknown;
        employee: unknown;
        currency: unknown;
        cost_rate: unknown;
        cost_amount: unknown;
        billable_rate: unknown;
        billable_amount: unknown;
      }>
    >(
      `SELECT (te.start_at AT TIME ZONE u.timezone)::date AS date,
              c.name AS client,
              p.name AS project,
              p.code AS project_code,
              COALESCE(pt.name, '') AS task,
              COALESCE(te.notes, '') AS notes,
              ROUND((EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)::numeric, 2) AS hours,
              CASE WHEN te.billable THEN 'Yes' ELSE 'No' END AS billable,
              SPLIT_PART(u.display_name, ' ', 1) AS first_name,
              CASE WHEN POSITION(' ' IN u.display_name) > 0
                   THEN SUBSTRING(u.display_name FROM POSITION(' ' IN u.display_name) + 1)
                   ELSE '' END AS last_name,
              u.display_name AS employee,
              p.currency,
              get_effective_cost_rate(te.user_id, te.start_at::date) AS cost_rate,
              ROUND(
                (EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0
                 * COALESCE(get_effective_cost_rate(te.user_id, te.start_at::date), 0))::numeric, 2
              ) AS cost_amount,
              get_effective_billable_rate(te.project_id, te.task_id, te.start_at::date) AS billable_rate,
              ROUND(
                (EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0
                 * COALESCE(get_effective_billable_rate(te.project_id, te.task_id, te.start_at::date), 0))::numeric, 2
              ) AS billable_amount
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       JOIN projects p ON p.id = te.project_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN project_tasks pt ON pt.id = te.task_id
       WHERE ${wheres.join(' AND ')}
       ORDER BY te.start_at ASC
       LIMIT ${SYNC_THRESHOLD}`,
      ...params,
    );

    return rows.map((r): XlsxRow => {
      const hours = Number(r.hours ?? 0);
      const out: XlsxRow = {
        date: r.date ? String(r.date) : '',
        client: r.client ? String(r.client) : '',
        project: r.project ? String(r.project) : '',
        project_code: r.project_code ? String(r.project_code) : '',
        task: r.task ? String(r.task) : '',
        notes: r.notes ? String(r.notes) : '',
        hours,
        hours_rounded: Math.round(hours * 4) / 4, // quarter-hour rounding for harvest compatibility
        billable: String(r.billable ?? ''),
        invoiced: '',
        approved: '',
        first_name: r.first_name ? String(r.first_name) : '',
        last_name: r.last_name ? String(r.last_name) : '',
        roles: '',
        employee: r.employee ? String(r.employee) : '',
        currency: r.currency ? String(r.currency) : '',
        external_reference_url: '',
        department: '',
        estimate: '',
      };
      if (canSeeFinancial) {
        out.billable_rate = r.billable_rate ? Number(r.billable_rate) : 0;
        out.billable_amount = r.billable_amount ? Number(r.billable_amount) : 0;
        out.cost_rate = r.cost_rate ? Number(r.cost_rate) : 0;
        out.cost_amount = r.cost_amount ? Number(r.cost_amount) : 0;
      }
      return out;
    });
  }
}
