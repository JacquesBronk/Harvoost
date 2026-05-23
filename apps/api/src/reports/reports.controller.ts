import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { RbacScopeService, ValidationFailedError } from '@harvoost/shared';
import { Roles } from '../common/roles.decorator';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';

const FilterSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  project_ids: z.array(z.string()).optional(),
  user_ids: z.array(z.string()).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

// `date_range=YYYY-MM-DD/YYYY-MM-DD` query param shared by the GET endpoints.
const DATE_RANGE_RE = /^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/;

function parseDateRange(raw: string | undefined): { from: string; to: string } {
  if (!raw || !DATE_RANGE_RE.test(raw)) {
    throw new ValidationFailedError(
      'date_range must be in the form YYYY-MM-DD/YYYY-MM-DD',
      { date_range: raw ?? null },
    );
  }
  const [from, to] = raw.split('/');
  if (!from || !to) {
    throw new ValidationFailedError('date_range malformed', { date_range: raw });
  }
  if (from > to) {
    throw new ValidationFailedError('date_range from must be <= to', { from, to });
  }
  return { from, to };
}

@Controller('v1/reports')
export class ReportsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
  ) {}

  @Post('detailed-activity')
  async detailedActivity(
    @CurrentUser() user: CurrentUserPayload,
    @Body(new ZodValidationPipe(FilterSchema)) body: z.infer<typeof FilterSchema>,
  ) {
    const canSeeFinancial = user.roles.includes('admin') || user.roles.includes('finmgr');
    const vu = await this.rbac.getVisibleUserIds(user.userId);
    const vp = await this.rbac.getVisibleProjectIds(user.userId);
    const userIds = vu.unrestricted ? null : vu.userIds;
    const projectIds = vp.unrestricted ? null : vp.projectIds;
    const params: unknown[] = [body.date_from, body.date_to];
    const wheres: string[] = [`te.start_at >= $1::date`, `te.start_at < ($2::date + INTERVAL '1 day')`];
    if (userIds) {
      params.push(userIds);
      wheres.push(`te.user_id = ANY($${params.length}::bigint[])`);
    }
    if (projectIds) {
      params.push(projectIds);
      wheres.push(`te.project_id = ANY($${params.length}::bigint[])`);
    }
    if (body.project_ids) {
      params.push(body.project_ids);
      wheres.push(`te.project_id = ANY($${params.length}::bigint[])`);
    }
    if (body.user_ids) {
      params.push(body.user_ids);
      wheres.push(`te.user_id = ANY($${params.length}::bigint[])`);
    }
    params.push(body.limit);
    const limitIdx = params.length;
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT te.id, te.user_id, te.project_id, te.start_at, te.end_at, te.notes, te.billable
       FROM time_entries te
       WHERE ${wheres.join(' AND ')}
       ORDER BY te.start_at DESC
       LIMIT $${limitIdx}::int`,
      ...params,
    );
    // Strip cost columns for non-financial roles — see API_NOTES.md.
    const data = rows.map((r) => {
      const out: Record<string, unknown> = { ...r };
      if (!canSeeFinancial) {
        delete out.cost_rate;
        delete out.cost_amount;
        delete out.billable_rate;
        delete out.billable_amount;
      }
      return out;
    });
    return { data, next_cursor: null, prev_cursor: null };
  }

  @Post('time-rollup')
  async timeRollup(@CurrentUser() user: CurrentUserPayload, @Body(new ZodValidationPipe(FilterSchema)) body: z.infer<typeof FilterSchema>) {
    // TODO(build-phase-followup): per-project / per-user rollup with margin if financial.
    return { data: [], filters: body, scope: { visible_users: user.userId }, todo: 'rollup' };
  }

  // ===========================================================================
  // Manager + financial dashboard endpoints (M7 fix — frontend invented these
  // but they weren't in the backend until now). Each is RBAC-scoped.
  // ===========================================================================

  // GET /v1/reports/team-dashboard?date_range=YYYY-MM-DD/YYYY-MM-DD
  //
  // Per-employee rollup of hours over the requested range, intersected with the
  // requester's RBAC scope. Used by /dashboard (manager + admin).
  @Get('team-dashboard')
  async teamDashboard(
    @CurrentUser() actor: CurrentUserPayload,
    @Query('date_range') dateRange?: string,
  ) {
    const { from, to } = parseDateRange(dateRange);
    const vu = await this.rbac.getVisibleUserIds(actor.userId);
    const vp = await this.rbac.getVisibleProjectIds(actor.userId);
    const visibleUserIds = vu.unrestricted ? null : vu.userIds;
    const visibleProjectIds = vp.unrestricted ? null : vp.projectIds;

    const params: unknown[] = [from, to];
    const wheres: string[] = [
      `te.start_at >= $1::date`,
      `te.start_at < ($2::date + INTERVAL '1 day')`,
      `te.end_at IS NOT NULL`,
    ];
    if (visibleUserIds) {
      params.push(visibleUserIds);
      wheres.push(`te.user_id = ANY($${params.length}::bigint[])`);
    }
    if (visibleProjectIds) {
      params.push(visibleProjectIds);
      wheres.push(`te.project_id = ANY($${params.length}::bigint[])`);
    }

    // Per-user aggregate hours.
    const userHours = await this.prisma.$queryRawUnsafe<
      Array<{
        user_id: unknown;
        display_name: unknown;
        total_hours: unknown;
        billable_hours: unknown;
        non_billable_hours: unknown;
      }>
    >(
      `SELECT u.id AS user_id,
              u.display_name,
              COALESCE(SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0), 0)::numeric(10,2) AS total_hours,
              COALESCE(SUM(CASE WHEN te.billable THEN EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0 ELSE 0 END), 0)::numeric(10,2) AS billable_hours,
              COALESCE(SUM(CASE WHEN NOT te.billable THEN EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0 ELSE 0 END), 0)::numeric(10,2) AS non_billable_hours
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE ${wheres.join(' AND ')}
       GROUP BY u.id, u.display_name
       ORDER BY u.display_name ASC`,
      ...params,
    );

    // Per-user top-5 project breakdown.
    const projectBreakdown = await this.prisma.$queryRawUnsafe<
      Array<{ user_id: unknown; project_id: unknown; project_name: unknown; hours: unknown; rk: unknown }>
    >(
      `SELECT t.user_id, t.project_id, t.project_name, t.hours, t.rk FROM (
         SELECT te.user_id,
                te.project_id,
                p.name AS project_name,
                SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)::numeric(10,2) AS hours,
                ROW_NUMBER() OVER (
                  PARTITION BY te.user_id
                  ORDER BY SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at))) DESC
                ) AS rk
         FROM time_entries te
         JOIN projects p ON p.id = te.project_id
         WHERE ${wheres.join(' AND ')}
         GROUP BY te.user_id, te.project_id, p.name
       ) t
       WHERE t.rk <= 5`,
      ...params,
    );

    // Exception counts (missed_punch + overtime_day) per user in range.
    const visibleUserParams: unknown[] = [from, to];
    const exceptionWheres: string[] = [
      `e.local_date >= $1::date`,
      `e.local_date <= $2::date`,
    ];
    if (visibleUserIds) {
      visibleUserParams.push(visibleUserIds);
      exceptionWheres.push(`e.user_id = ANY($${visibleUserParams.length}::bigint[])`);
    }
    const exceptionCounts = await this.prisma.$queryRawUnsafe<
      Array<{ user_id: unknown; missed_punch_count: unknown; overtime_count: unknown }>
    >(
      `SELECT e.user_id,
              COUNT(*) FILTER (WHERE e.exception_type = 'MISSED_PUNCH')::int AS missed_punch_count,
              COUNT(*) FILTER (WHERE e.exception_type IN ('OVERTIME_DAY', 'OVERTIME_WEEK'))::int AS overtime_count
       FROM exceptions e
       WHERE ${exceptionWheres.join(' AND ')}
       GROUP BY e.user_id`,
      ...visibleUserParams,
    );

    const breakdownByUser: Record<string, Array<{ project_id: string; project_name: string; hours: number }>> = {};
    for (const row of projectBreakdown) {
      const uid = String(row.user_id);
      if (!breakdownByUser[uid]) breakdownByUser[uid] = [];
      breakdownByUser[uid].push({
        project_id: String(row.project_id),
        project_name: String(row.project_name),
        hours: Number(row.hours ?? 0),
      });
    }
    const exceptionsByUser: Record<string, { missed_punch_count: number; overtime_count: number }> = {};
    for (const row of exceptionCounts) {
      exceptionsByUser[String(row.user_id)] = {
        missed_punch_count: Number(row.missed_punch_count ?? 0),
        overtime_count: Number(row.overtime_count ?? 0),
      };
    }

    // Envelope key is `items` to match the FE `ScopedList<T>` convention
    // (INC-004 Row 1). team-dashboard carries HOURS only — no cost columns —
    // so there is no cost-stripping concern here.
    return {
      items: userHours.map((r) => {
        const uid = String(r.user_id);
        const exc = exceptionsByUser[uid] ?? { missed_punch_count: 0, overtime_count: 0 };
        return {
          user_id: uid,
          display_name: String(r.display_name),
          total_hours: Number(r.total_hours ?? 0),
          billable_hours: Number(r.billable_hours ?? 0),
          non_billable_hours: Number(r.non_billable_hours ?? 0),
          hours_by_project: breakdownByUser[uid] ?? [],
          missed_punch_count: exc.missed_punch_count,
          overtime_count: exc.overtime_count,
        };
      }),
      date_range: { from, to },
      scope_meta: {
        visible_users: vu.unrestricted ? 'all' : vu.userIds.length,
        visible_projects: vp.unrestricted ? 'all' : vp.projectIds.length,
      },
    };
  }

  // GET /v1/reports/profitability?date_range=YYYY-MM-DD/YYYY-MM-DD
  //
  // Per-project profitability rollup; admin + finmgr only. Cost is computed via
  // get_effective_cost_rate(user_id, date) helper from the init migration.
  // Revenue depends on billing_mode:
  //   - hourly:       hours × project_billable_rate at entry date (per task)
  //   - fixed_fee:    project.fixed_fee_amount (counted once, not per entry)
  //   - non_billable: 0
  // Sorted by margin% ascending (worst first per REQUIREMENTS F4.2).
  @Roles('admin', 'finmgr')
  @Get('profitability')
  async profitability(@Query('date_range') dateRange?: string) {
    const { from, to } = parseDateRange(dateRange);

    // Aggregate per-entry cost + revenue.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        project_id: unknown;
        project_name: unknown;
        billing_mode: unknown;
        fixed_fee_amount: unknown;
        currency: unknown;
        total_hours: unknown;
        billable_hours: unknown;
        cost: unknown;
        hourly_revenue: unknown;
      }>
    >(
      `SELECT p.id AS project_id,
              p.name AS project_name,
              p.billing_mode,
              p.fixed_fee_amount,
              p.currency,
              COALESCE(SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0), 0)::numeric(10,2) AS total_hours,
              COALESCE(SUM(CASE WHEN te.billable
                                THEN EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0
                                ELSE 0 END), 0)::numeric(10,2) AS billable_hours,
              COALESCE(SUM(
                (EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)
                * COALESCE(get_effective_cost_rate(te.user_id, te.start_at::date), 0)
              ), 0)::numeric(14,2) AS cost,
              COALESCE(SUM(
                CASE WHEN p.billing_mode = 'hourly' AND te.billable
                     THEN (EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)
                          * COALESCE(get_effective_billable_rate(te.project_id, te.task_id, te.start_at::date), 0)
                     ELSE 0 END
              ), 0)::numeric(14,2) AS hourly_revenue
       FROM projects p
       LEFT JOIN time_entries te
         ON te.project_id = p.id
        AND te.start_at >= $1::date
        AND te.start_at < ($2::date + INTERVAL '1 day')
        AND te.end_at IS NOT NULL
       WHERE p.is_active = TRUE
       GROUP BY p.id, p.name, p.billing_mode, p.fixed_fee_amount, p.currency`,
      from,
      to,
    );

    // Billing-mode breakdown within range (history is sparse so we only emit
    // a breakdown when the project's billing_mode changed inside [from, to]).
    const modeHistory = await this.prisma.$queryRawUnsafe<
      Array<{ project_id: unknown; billing_mode: unknown; effective_from: unknown; effective_to: unknown }>
    >(
      `SELECT project_id, billing_mode, effective_from, effective_to
       FROM project_billing_mode_history
       WHERE effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to >= $1::date)
       ORDER BY project_id, effective_from`,
      from,
      to,
    );
    const modeByProject: Record<string, Array<{ billing_mode: string; effective_from: string; effective_to: string | null }>> = {};
    for (const m of modeHistory) {
      const pid = String(m.project_id);
      if (!modeByProject[pid]) modeByProject[pid] = [];
      modeByProject[pid].push({
        billing_mode: String(m.billing_mode),
        effective_from: String(m.effective_from),
        effective_to: m.effective_to ? String(m.effective_to) : null,
      });
    }

    const data = rows.map((r) => {
      const pid = String(r.project_id);
      const billingMode = String(r.billing_mode);
      const fixedFee = r.fixed_fee_amount ? Number(r.fixed_fee_amount) : 0;
      const hourlyRev = Number(r.hourly_revenue ?? 0);
      // Fixed-fee revenue is counted once per project in the period.
      const revenue =
        billingMode === 'fixed_fee'
          ? fixedFee
          : billingMode === 'non_billable'
            ? 0
            : hourlyRev;
      const cost = Number(r.cost ?? 0);
      const margin = revenue - cost;
      const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
      const breakdown = modeByProject[pid] ?? [];
      return {
        project_id: pid,
        // INC-004 Row 2: field names aligned to the FE `FinancialProjectRow`
        // type (`project_name`, `hours`). Cost/revenue/margin unchanged.
        project_name: String(r.project_name),
        billing_mode: billingMode,
        currency: String(r.currency),
        revenue: Number(revenue.toFixed(2)),
        cost: Number(cost.toFixed(2)),
        margin: Number(margin.toFixed(2)),
        margin_pct: Number(marginPct.toFixed(2)),
        hours: Number(r.total_hours ?? 0),
        billable_hours: Number(r.billable_hours ?? 0),
        billing_mode_breakdown: breakdown.length > 1 ? breakdown : null,
      };
    });

    // Worst margin first (NULL/zero-revenue projects float to the bottom).
    data.sort((a, b) => {
      if (a.revenue === 0 && b.revenue === 0) return 0;
      if (a.revenue === 0) return 1;
      if (b.revenue === 0) return -1;
      return a.margin_pct - b.margin_pct;
    });

    // Envelope key is `items` to match the FE `Paginated<FinancialProjectRow>`
    // read (INC-004 Row 2). RBAC stays @Roles('admin','finmgr') — cost/margin
    // are financial-only.
    return { items: data, date_range: { from, to } };
  }

  // GET /v1/reports/employees/:userId/rollup?date_range=...
  //
  // Per-employee rollup intersected with the actor's RBAC scope. Projects the
  // actor cannot see are collapsed into a single { project_id: null,
  // project_name: 'Other projects (N)', hours } bucket per REQUIREMENTS F3.2.
  @Get('employees/:userId/rollup')
  async employeeRollup(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('userId') userId: string,
    @Query('date_range') dateRange?: string,
  ) {
    await this.rbac.assertCanSeeUser(actor.userId, userId);
    const { from, to } = parseDateRange(dateRange);

    const vp = await this.rbac.getVisibleProjectIds(actor.userId);
    const visibleProjectIds = vp.unrestricted ? null : vp.projectIds;

    // Header (employee identity).
    const headerRows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown; display_name: unknown; email: unknown; timezone: unknown }>>(
      `SELECT id, display_name, email, timezone FROM users WHERE id = $1::bigint LIMIT 1`,
      userId,
    );
    if (headerRows.length === 0) {
      return { error: 'user_not_found' };
    }
    const header = headerRows[0]!;

    // Per-project hours for this employee in range. Mark visible vs not.
    const projectRows = await this.prisma.$queryRawUnsafe<
      Array<{ project_id: unknown; project_name: unknown; hours: unknown }>
    >(
      `SELECT te.project_id, p.name AS project_name,
              SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)::numeric(10,2) AS hours
       FROM time_entries te
       JOIN projects p ON p.id = te.project_id
       WHERE te.user_id = $1::bigint
         AND te.start_at >= $2::date
         AND te.start_at < ($3::date + INTERVAL '1 day')
         AND te.end_at IS NOT NULL
       GROUP BY te.project_id, p.name
       ORDER BY hours DESC`,
      userId,
      from,
      to,
    );

    const visibleSet = visibleProjectIds ? new Set(visibleProjectIds.map(String)) : null;
    const hoursByProject: Array<{ project_id: string | null; project_name: string; hours: number }> = [];
    let otherHours = 0;
    let otherCount = 0;
    for (const r of projectRows) {
      const pid = String(r.project_id);
      const hours = Number(r.hours ?? 0);
      if (!visibleSet || visibleSet.has(pid)) {
        hoursByProject.push({ project_id: pid, project_name: String(r.project_name), hours });
      } else {
        otherHours += hours;
        otherCount += 1;
      }
    }
    if (otherCount > 0) {
      hoursByProject.push({
        project_id: null,
        project_name: `Other projects (${otherCount})`,
        hours: Number(otherHours.toFixed(2)),
      });
    }

    // Per-day timeline.
    const timeline = await this.prisma.$queryRawUnsafe<Array<{ day: unknown; hours: unknown }>>(
      `SELECT (te.start_at AT TIME ZONE u.timezone)::date AS day,
              SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)::numeric(10,2) AS hours
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.user_id = $1::bigint
         AND te.start_at >= $2::date
         AND te.start_at < ($3::date + INTERVAL '1 day')
         AND te.end_at IS NOT NULL
       GROUP BY day
       ORDER BY day ASC`,
      userId,
      from,
      to,
    );

    // Exceptions for this employee (within actor's RBAC scope still applies
    // because the actor was assertCanSeeUser'd above — RBAC visibility is on
    // the *user*, not on the exception row itself).
    const exceptions = await this.prisma.$queryRawUnsafe<
      Array<{ id: unknown; exception_type: unknown; local_date: unknown; status: unknown; details: unknown }>
    >(
      `SELECT id, exception_type, local_date, status, details
       FROM exceptions
       WHERE user_id = $1::bigint
         AND local_date >= $2::date
         AND local_date <= $3::date
       ORDER BY local_date DESC
       LIMIT 100`,
      userId,
      from,
      to,
    );

    return {
      user: {
        id: String(header.id),
        display_name: String(header.display_name),
        email: String(header.email),
        timezone: String(header.timezone),
      },
      date_range: { from, to },
      hours_by_project: hoursByProject,
      timeline: timeline.map((t) => ({
        day: String(t.day),
        hours: Number(t.hours ?? 0),
      })),
      exceptions: exceptions.map((e) => ({
        id: String(e.id),
        type: String(e.exception_type),
        local_date: String(e.local_date),
        status: String(e.status),
        details: e.details,
      })),
    };
  }

  // GET /v1/reports/projects/:projectId/rollup?date_range=...
  //
  // Project rollup with per-member + per-task breakdowns. RBAC: requester must
  // be able to see the project. Underlying time-entries are RBAC-filtered.
  @Get('projects/:projectId/rollup')
  async projectRollup(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('projectId') projectId: string,
    @Query('date_range') dateRange?: string,
  ) {
    await this.rbac.assertCanSeeProject(actor.userId, projectId);
    const { from, to } = parseDateRange(dateRange);

    const vu = await this.rbac.getVisibleUserIds(actor.userId);
    const visibleUserIds = vu.unrestricted ? null : vu.userIds;

    // Header.
    const headerRows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: unknown;
        name: unknown;
        billing_mode: unknown;
        fixed_fee_amount: unknown;
        currency: unknown;
        hours_budget: unknown;
        client_name: unknown;
      }>
    >(
      `SELECT p.id, p.name, p.billing_mode, p.fixed_fee_amount, p.currency, p.hours_budget,
              c.name AS client_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1::bigint
       LIMIT 1`,
      projectId,
    );
    if (headerRows.length === 0) {
      return { error: 'project_not_found' };
    }
    const header = headerRows[0]!;

    // Total hours.
    const totalParams: unknown[] = [projectId, from, to];
    let totalUserFilter = '';
    if (visibleUserIds) {
      totalParams.push(visibleUserIds);
      totalUserFilter = ` AND te.user_id = ANY($${totalParams.length}::bigint[])`;
    }
    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ total_hours: unknown }>>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0), 0)::numeric(10,2) AS total_hours
       FROM time_entries te
       WHERE te.project_id = $1::bigint
         AND te.start_at >= $2::date
         AND te.start_at < ($3::date + INTERVAL '1 day')
         AND te.end_at IS NOT NULL${totalUserFilter}`,
      ...totalParams,
    );
    const totalHours = Number(totalRows[0]?.total_hours ?? 0);

    // Hours by member (RBAC-filtered).
    const memberRows = await this.prisma.$queryRawUnsafe<
      Array<{ user_id: unknown; display_name: unknown; hours: unknown }>
    >(
      `SELECT te.user_id, u.display_name,
              SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)::numeric(10,2) AS hours
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.project_id = $1::bigint
         AND te.start_at >= $2::date
         AND te.start_at < ($3::date + INTERVAL '1 day')
         AND te.end_at IS NOT NULL${totalUserFilter}
       GROUP BY te.user_id, u.display_name
       ORDER BY hours DESC`,
      ...totalParams,
    );

    // Hours by task.
    const taskRows = await this.prisma.$queryRawUnsafe<
      Array<{ task_id: unknown; task_name: unknown; hours: unknown }>
    >(
      `SELECT te.task_id, COALESCE(pt.name, '(no task)') AS task_name,
              SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0)::numeric(10,2) AS hours
       FROM time_entries te
       LEFT JOIN project_tasks pt ON pt.id = te.task_id
       WHERE te.project_id = $1::bigint
         AND te.start_at >= $2::date
         AND te.start_at < ($3::date + INTERVAL '1 day')
         AND te.end_at IS NOT NULL${totalUserFilter}
       GROUP BY te.task_id, pt.name
       ORDER BY hours DESC`,
      ...totalParams,
    );

    const hoursBudget = header.hours_budget ? Number(header.hours_budget) : null;

    return {
      project: {
        id: String(header.id),
        name: String(header.name),
        client_name: header.client_name ? String(header.client_name) : null,
        billing_mode: String(header.billing_mode),
        fixed_fee_amount: header.fixed_fee_amount ? Number(header.fixed_fee_amount) : null,
        currency: String(header.currency),
        hours_budget: hoursBudget,
      },
      date_range: { from, to },
      total_hours: totalHours,
      hours_by_member: memberRows.map((r) => ({
        user_id: String(r.user_id),
        display_name: String(r.display_name),
        hours: Number(r.hours ?? 0),
      })),
      hours_by_task: taskRows.map((r) => ({
        task_id: r.task_id ? String(r.task_id) : null,
        task_name: String(r.task_name),
        hours: Number(r.hours ?? 0),
      })),
      budget: hoursBudget !== null
        ? {
            hours_budget: hoursBudget,
            hours_used: totalHours,
            hours_remaining: Number((hoursBudget - totalHours).toFixed(2)),
            percent_used: hoursBudget > 0 ? Number(((totalHours / hoursBudget) * 100).toFixed(2)) : 0,
          }
        : null,
    };
  }
}
