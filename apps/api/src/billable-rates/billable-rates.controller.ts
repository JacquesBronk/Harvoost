import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { AuditService } from '../common/audit/audit.service';
import { ValidationFailedError } from '@harvoost/shared';

// INC-004 Row 5 — project billable rates (effective-dated, per-project + per-task).
//
// Backed by the pre-existing `project_billable_rates` table + `pbr_no_overlap`
// GiST exclusion + `get_effective_billable_rate(project_id, task_id, date)`
// helper (init migration). NO new migration.
//
// RBAC: billable rates are financial data — the controller is gated to
// Admin/FinMgr. `created_by` is the actor; POST records an audit entry.
//
// FE convention: a row with `task_id == null` is the project default rate.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const CreateBillableRateSchema = z
  .object({
    project_id: z.string().regex(/^\d+$/),
    task_id: z.string().regex(/^\d+$/).optional(),
    rate: z.number().min(0).max(99_999_999),
    currency: z.string().length(3),
    effective_from: z.string().regex(DATE_ONLY_RE),
  })
  .strict();

function clampPage(raw: string | undefined): number {
  return Math.max(parseInt(raw ?? '1', 10) || 1, 1);
}
function clampPageSize(raw: string | undefined): number {
  return Math.min(Math.max(parseInt(raw ?? '50', 10) || 50, 1), 200);
}

@Roles('admin', 'finmgr')
@Controller('v1/billable-rates')
export class BillableRatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // GET /v1/billable-rates?current=true       → current rate per project+task
  // GET /v1/billable-rates?project_id=<id>    → that project's full history
  @Get()
  async list(
    @Query('current') current?: string,
    @Query('project_id') projectId?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const p = clampPage(page);
    const ps = clampPageSize(pageSize);
    const offset = (p - 1) * ps;

    if (projectId) {
      if (!/^\d+$/.test(projectId)) {
        throw new ValidationFailedError('project_id must be numeric', { project_id: projectId });
      }
      const totalRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
        `SELECT COUNT(*)::int AS n FROM project_billable_rates WHERE project_id = $1::bigint`,
        projectId,
      );
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT pbr.id, pbr.project_id, p.name AS project_name,
                pbr.task_id, pt.name AS task_name,
                pbr.rate, pbr.currency, pbr.effective_from, pbr.effective_to,
                pbr.created_by, pbr.created_at
         FROM project_billable_rates pbr
         JOIN projects p ON p.id = pbr.project_id
         LEFT JOIN project_tasks pt ON pt.id = pbr.task_id
         WHERE pbr.project_id = $1::bigint
         ORDER BY pbr.effective_from DESC, pbr.id DESC
         LIMIT $2::int OFFSET $3::int`,
        projectId,
        ps,
        offset,
      );
      return {
        data: rows.map(mapRow),
        page: p,
        page_size: ps,
        total_count: Number(totalRows[0]?.n ?? 0),
      };
    }

    const currentOnly = current === undefined || current === 'true' || current === '1';
    const whereCurrent = currentOnly
      ? `WHERE pbr.effective_from <= CURRENT_DATE
           AND (pbr.effective_to IS NULL OR pbr.effective_to > CURRENT_DATE)`
      : '';
    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*)::int AS n FROM project_billable_rates pbr ${whereCurrent}`,
    );
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT pbr.id, pbr.project_id, p.name AS project_name,
              pbr.task_id, pt.name AS task_name,
              pbr.rate, pbr.currency, pbr.effective_from, pbr.effective_to,
              pbr.created_by, pbr.created_at
       FROM project_billable_rates pbr
       JOIN projects p ON p.id = pbr.project_id
       LEFT JOIN project_tasks pt ON pt.id = pbr.task_id
       ${whereCurrent}
       ORDER BY p.name ASC, pbr.task_id NULLS FIRST, pbr.effective_from DESC
       LIMIT $1::int OFFSET $2::int`,
      ps,
      offset,
    );
    return {
      data: rows.map(mapRow),
      page: p,
      page_size: ps,
      total_count: Number(totalRows[0]?.n ?? 0),
    };
  }

  // POST /v1/billable-rates {project_id, task_id?, rate, currency, effective_from}
  // New effective-dated row; end-date the prior open row for the same
  // (project_id, task_id) tuple. pbr_no_overlap GiST 23P01 → clean 422 conflict.
  @Post()
  async create(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(CreateBillableRateSchema)) body: z.infer<typeof CreateBillableRateSchema>,
  ) {
    const taskId = body.task_id ?? null;
    let row: Record<string, unknown>;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        // End-date the prior open row for the same project+task tuple. NULL
        // task_id is compared with IS NOT DISTINCT FROM so the project-default
        // row matches itself (and not the task-specific rows).
        await tx.$executeRawUnsafe(
          `UPDATE project_billable_rates
             SET effective_to = $3::date
           WHERE project_id = $1::bigint
             AND task_id IS NOT DISTINCT FROM $2::bigint
             AND effective_to IS NULL
             AND effective_from < $3::date`,
          body.project_id,
          taskId,
          body.effective_from,
        );
        const inserted = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `INSERT INTO project_billable_rates
             (project_id, task_id, rate, currency, effective_from, created_by)
           VALUES ($1::bigint, $2::bigint, $3::numeric, $4, $5::date, $6::bigint)
           RETURNING id, project_id, task_id, rate, currency, effective_from,
                     effective_to, created_by, created_at`,
          body.project_id,
          taskId,
          body.rate,
          body.currency.toUpperCase(),
          body.effective_from,
          actor.userId,
        );
        return inserted[0]!;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/23P01|exclusion_violation|pbr_no_overlap/i.test(message)) {
        throw new ValidationFailedError(
          'Conflicting billable rate exists for this project/task in the requested period.',
          { code: 'BILLABLE_RATE_CONFLICT' },
        );
      }
      throw err;
    }

    const id = String(row.id);
    await this.audit.record({
      actorId: actor.userId,
      action: 'billable_rate.create',
      entityType: 'project_billable_rate',
      entityId: id,
      after: {
        project_id: body.project_id,
        task_id: taskId,
        rate: body.rate,
        currency: body.currency.toUpperCase(),
        effective_from: body.effective_from,
      },
    });
    return mapRow(row);
  }
}

function mapRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    project_id: r.project_id != null ? String(r.project_id) : null,
    project_name: r.project_name != null ? String(r.project_name) : undefined,
    task_id: r.task_id != null ? String(r.task_id) : null,
    task_name: r.task_name != null ? String(r.task_name) : null,
    rate: r.rate != null ? Number(r.rate) : 0,
    currency: r.currency != null ? String(r.currency) : '',
    effective_from: r.effective_from != null ? toDateStr(r.effective_from) : null,
    effective_to: r.effective_to != null ? toDateStr(r.effective_to) : null,
    created_by: r.created_by != null ? String(r.created_by) : null,
    created_at: r.created_at != null ? String(r.created_at) : null,
  };
}

function toDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}
