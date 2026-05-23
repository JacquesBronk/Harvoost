import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { AuditService } from '../common/audit/audit.service';
import { ValidationFailedError } from '@harvoost/shared';

// INC-004 Row 4 — employee cost rates (effective-dated).
//
// Backed by the pre-existing `employee_cost_rates` table + `ecr_no_overlap`
// GiST exclusion + `get_effective_cost_rate(user_id, date)` helper (init
// migration). NO new migration.
//
// RBAC: cost rates ARE financial data — the whole controller is gated to
// Admin/FinMgr. `created_by` is taken from the actor; a POST records an audit
// entry mirroring the SchedulesController pattern.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const CreateCostRateSchema = z
  .object({
    user_id: z.string().regex(/^\d+$/),
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
@Controller('v1/cost-rates')
export class CostRatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // GET /v1/cost-rates?current=true        → current rate per user (one row each)
  // GET /v1/cost-rates?user_id=<id>        → that user's full history
  @Get()
  async list(
    @Query('current') current?: string,
    @Query('user_id') userId?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const p = clampPage(page);
    const ps = clampPageSize(pageSize);
    const offset = (p - 1) * ps;

    if (userId) {
      if (!/^\d+$/.test(userId)) {
        throw new ValidationFailedError('user_id must be numeric', { user_id: userId });
      }
      // Full history for one user, newest first.
      const totalRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
        `SELECT COUNT(*)::int AS n FROM employee_cost_rates WHERE user_id = $1::bigint`,
        userId,
      );
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT ecr.id, ecr.user_id, u.display_name AS user_display_name,
                ecr.rate, ecr.currency, ecr.effective_from, ecr.effective_to,
                ecr.created_by, ecr.created_at
         FROM employee_cost_rates ecr
         JOIN users u ON u.id = ecr.user_id
         WHERE ecr.user_id = $1::bigint
         ORDER BY ecr.effective_from DESC, ecr.id DESC
         LIMIT $2::int OFFSET $3::int`,
        userId,
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

    // Current rate per user: effective_from <= today AND
    // (effective_to IS NULL OR effective_to > today). `current` defaults on.
    const currentOnly = current === undefined || current === 'true' || current === '1';
    const whereCurrent = currentOnly
      ? `WHERE ecr.effective_from <= CURRENT_DATE
           AND (ecr.effective_to IS NULL OR ecr.effective_to > CURRENT_DATE)`
      : '';
    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*)::int AS n FROM employee_cost_rates ecr ${whereCurrent}`,
    );
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ecr.id, ecr.user_id, u.display_name AS user_display_name,
              ecr.rate, ecr.currency, ecr.effective_from, ecr.effective_to,
              ecr.created_by, ecr.created_at
       FROM employee_cost_rates ecr
       JOIN users u ON u.id = ecr.user_id
       ${whereCurrent}
       ORDER BY u.display_name ASC, ecr.effective_from DESC
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

  // POST /v1/cost-rates {user_id, rate, currency, effective_from}
  // Creates a new effective-dated row and end-dates the prior open row. The
  // ecr_no_overlap GiST exclusion guards against overlapping windows; a 23P01
  // is mapped to a clean 422 conflict.
  @Post()
  async create(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(CreateCostRateSchema)) body: z.infer<typeof CreateCostRateSchema>,
  ) {
    let row: Record<string, unknown>;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        // End-date the prior open row so its window closes at the new start.
        await tx.$executeRawUnsafe(
          `UPDATE employee_cost_rates
             SET effective_to = $2::date
           WHERE user_id = $1::bigint
             AND effective_to IS NULL
             AND effective_from < $2::date`,
          body.user_id,
          body.effective_from,
        );
        const inserted = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `INSERT INTO employee_cost_rates
             (user_id, rate, currency, effective_from, created_by)
           VALUES ($1::bigint, $2::numeric, $3, $4::date, $5::bigint)
           RETURNING id, user_id, rate, currency, effective_from, effective_to,
                     created_by, created_at`,
          body.user_id,
          body.rate,
          body.currency.toUpperCase(),
          body.effective_from,
          actor.userId,
        );
        return inserted[0]!;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/23P01|exclusion_violation|ecr_no_overlap/i.test(message)) {
        throw new ValidationFailedError(
          'Conflicting cost rate exists for this user in the requested period.',
          { code: 'COST_RATE_CONFLICT' },
        );
      }
      throw err;
    }

    const id = String(row.id);
    await this.audit.record({
      actorId: actor.userId,
      action: 'cost_rate.create',
      entityType: 'employee_cost_rate',
      entityId: id,
      after: {
        user_id: body.user_id,
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
    user_id: r.user_id != null ? String(r.user_id) : null,
    user_display_name: r.user_display_name != null ? String(r.user_display_name) : undefined,
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
