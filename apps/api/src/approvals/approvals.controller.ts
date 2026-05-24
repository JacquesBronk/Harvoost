import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RbacForbiddenError, RbacScopeService, ValidationFailedError } from '@harvoost/shared';
import { Roles } from '../common/roles.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { PeriodService } from '../timesheet-periods/period.service';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';

const ManagerActionSchema = z.object({
  entry_ids: z.array(z.string()).min(1),
  action: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
});

const FinalActionSchema = ManagerActionSchema;

const AdminUnlockSchema = z.object({
  reason: z.string().min(20),
});

// FEAT-002 (issue #6) — the approvals queue is grouped per (user, ISO-week) and RBAC-scoped.
// `stage` drives which entry status the queue groups: manager stage groups 'submitted' entries
// (managers/admin); final stage groups 'manager_approved' entries (finmgr/admin).
const QueueQuery = z.object({
  stage: z.enum(['manager', 'final']).optional(),
  user_id: z.string().regex(/^\d+$/).optional(),
  iso_week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// One row of the enriched approvals queue (the pinned FEAT-002 contract the FE consumes).
interface ApprovalQueueItem {
  id: string; // timesheet_periods row id if one exists, else "${user_id}-${iso_year}-${iso_week}"
  user_id: string;
  user_name: string; // users.display_name
  iso_week: string; // "YYYY-Www" (ISO year + week, in the entry OWNER's timezone)
  total_hours: number; // sum of that user's entries in the relevant status for that week
  status: string; // 'submitted' (manager stage) or 'manager_approved' (final stage)
  submitted_at: string; // representative (earliest) submitted timestamp for the group
}

@Controller('v1/approvals')
export class ApprovalsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly periods: PeriodService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
  ) {}

  // FEAT-002 (issue #6): after a batch of per-entry transitions, recompute the affected periods
  // so the derived period status follows the entries (DESIGN §2/§4). Resolves each entry's
  // (user_id, ISO-week) in the owner's TZ and recomputes each distinct week once. NO contract
  // change to the approval endpoints; this only keeps the period rollup consistent.
  private async recomputeAffectedPeriods(entryIds: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const entryId of entryIds) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ user_id: unknown; start_at: unknown }>>(
        `SELECT user_id, start_at FROM time_entries WHERE id = $1::bigint LIMIT 1`,
        entryId,
      );
      if (rows.length === 0) continue;
      const userId = String(rows[0]!.user_id);
      const userTz = await this.periods.getUserTz(this.prisma, userId);
      const { isoYear, isoWeek } = await this.periods.resolveWeek(
        this.prisma,
        userTz,
        rows[0]!.start_at as string | Date,
      );
      const key = `${userId}:${isoYear}:${isoWeek}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.periods.recomputePeriod(this.prisma, userId, userTz, isoYear, isoWeek);
    }
  }

  // GET /v1/approvals/queue?stage=manager|final&limit=N → { data: ApprovalQueueItem[] }
  // FEAT-002 (issue #6) — the ENRICHED, RBAC-scoped, per-(user, ISO-week) approval inbox.
  //
  // Grouping: entries are bucketed by (user_id, ISO-week-of-start_at-in-the-OWNER's-TZ), summing
  // hours per group and joining users.display_name. The ISO-week uses the SAME
  // EXTRACT(ISOYEAR/WEEK FROM (start_at AT TIME ZONE user_tz)) convention the period service +
  // DB trigger use, so a group aligns exactly with its timesheet_periods row.
  //
  // Stage → status: the FE sends ?stage. stage=manager groups 'submitted' entries (manager/admin
  // inbox); stage=final groups 'manager_approved' entries (finmgr/admin inbox). When stage is
  // absent we FALL BACK to inferring it from the caller's roles (finmgr → final, else manager),
  // matching the legacy behavior.
  //
  // RBAC: scoped to the caller's visible users via getVisibleUserIds — a manager sees only their
  // anchored team's weeks, never the whole org. admin/finmgr are unrestricted and short-circuit
  // the IN-filter (they see every group at the relevant stage). A caller with neither the
  // manager nor finmgr/admin capability for the resolved stage gets an empty queue.
  @Get('queue')
  async queue(
    @CurrentUser() user: CurrentUserPayload,
    @Query(new ZodValidationPipe(QueueQuery)) q: z.infer<typeof QueueQuery>,
  ) {
    const isAdmin = user.roles.includes('admin');
    const isFin = user.roles.includes('finmgr');
    const isManager = user.roles.includes('manager');

    // Resolve the stage: explicit ?stage wins; else infer from roles (legacy fallback).
    let stage: 'manager' | 'final' | null = q.stage ?? null;
    if (stage === null) {
      stage = isFin ? 'final' : isManager || isAdmin ? 'manager' : null;
    }
    if (stage === null) return { data: [] };

    // Authorize the requested stage against the caller's capabilities. Manager stage requires
    // manager OR admin; final stage requires finmgr OR admin. This prevents a manager from
    // peeking at the finance (stage-2) queue and vice-versa.
    if (stage === 'manager' && !(isManager || isAdmin)) return { data: [] };
    if (stage === 'final' && !(isFin || isAdmin)) return { data: [] };

    const status = stage === 'final' ? 'manager_approved' : 'submitted';

    // RBAC visibility set for the caller. admin/finmgr are unrestricted (see the whole org).
    const visible = await this.rbac.getVisibleUserIds(user.userId);

    const params: unknown[] = [status];
    const wheres: string[] = [`te.status = $1`];

    // Scope to visible users unless unrestricted (admin/finmgr).
    if (!visible.unrestricted) {
      params.push(visible.userIds);
      wheres.push(`te.user_id = ANY($${params.length}::bigint[])`);
    }
    // Optional explicit user_id narrowing (must be RBAC-visible — self always passes).
    if (q.user_id) {
      await this.rbac.assertCanSeeUser(user.userId, q.user_id);
      params.push(q.user_id);
      wheres.push(`te.user_id = $${params.length}::bigint`);
    }
    params.push(q.limit);
    const limitIdx = params.length;

    // Group per (user, ISO-week-in-owner-TZ). total_hours sums the entry durations (closed
    // entries only; an entry in 'submitted'/'manager_approved' is never running, so end_at is
    // always set). submitted_at is the earliest transition-into-`status` timestamp from
    // time_entry_state_history (the true "submitted at"); we also LEFT JOIN timesheet_periods so
    // the row id and its persisted submitted_at are preferred when the period row exists. iso_week
    // is rendered "YYYY-Www" with EXTRACT in the owner's TZ — identical to the period convention.
    const sql = `
      WITH grouped AS (
        SELECT
          te.user_id,
          EXTRACT(ISOYEAR FROM (te.start_at AT TIME ZONE u.timezone))::int AS iso_year,
          EXTRACT(WEEK    FROM (te.start_at AT TIME ZONE u.timezone))::int AS iso_week,
          u.display_name AS user_name,
          SUM(EXTRACT(EPOCH FROM (te.end_at - te.start_at)) / 3600.0) AS total_hours,
          MIN(h.first_submitted_at) AS history_submitted_at,
          MIN(te.updated_at) AS min_updated_at
        FROM time_entries te
        JOIN users u ON u.id = te.user_id
        LEFT JOIN LATERAL (
          SELECT MIN(seh.created_at) AS first_submitted_at
          FROM time_entry_state_history seh
          WHERE seh.time_entry_id = te.id AND seh.to_status = $1
        ) h ON TRUE
        WHERE ${wheres.join(' AND ')}
        GROUP BY te.user_id, u.display_name,
                 EXTRACT(ISOYEAR FROM (te.start_at AT TIME ZONE u.timezone))::int,
                 EXTRACT(WEEK    FROM (te.start_at AT TIME ZONE u.timezone))::int
      )
      SELECT
        tp.id AS period_id,
        g.user_id,
        g.user_name,
        g.iso_year,
        g.iso_week,
        g.total_hours,
        COALESCE(tp.submitted_at, g.history_submitted_at, g.min_updated_at) AS submitted_at
      FROM grouped g
      LEFT JOIN timesheet_periods tp
        ON tp.user_id = g.user_id AND tp.iso_year = g.iso_year AND tp.iso_week = g.iso_week
      ORDER BY g.iso_year DESC, g.iso_week DESC, submitted_at DESC
      LIMIT $${limitIdx}::int`;

    type QueueRow = {
      period_id: unknown;
      user_id: unknown;
      user_name: unknown;
      iso_year: unknown;
      iso_week: unknown;
      total_hours: unknown;
      submitted_at: unknown;
    };
    const rows = await this.prisma.$queryRawUnsafe<QueueRow[]>(sql, ...params);

    const data: ApprovalQueueItem[] = rows.map((r) => {
      const userId = String(r.user_id);
      const isoYear = Number(r.iso_year);
      const isoWeekNum = Number(r.iso_week);
      const isoWeek = `${isoYear}-W${String(isoWeekNum).padStart(2, '0')}`;
      const submittedAt = r.submitted_at instanceof Date ? r.submitted_at.toISOString() : (r.submitted_at == null ? '' : String(r.submitted_at));
      return {
        id: r.period_id != null ? String(r.period_id) : `${userId}-${isoYear}-${isoWeekNum}`,
        user_id: userId,
        user_name: r.user_name == null ? '' : String(r.user_name),
        iso_week: isoWeek,
        total_hours: Math.round(Number(r.total_hours ?? 0) * 100) / 100,
        status,
        submitted_at: submittedAt,
      };
    });

    return { data };
  }

  @Roles('manager', 'admin')
  @Post('timesheets/manager')
  async managerAction(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(ManagerActionSchema)) body: z.infer<typeof ManagerActionSchema>,
  ) {
    if (body.action === 'reject' && (!body.reason || body.reason.length < 10)) {
      throw new ValidationFailedError('Reject requires a reason of at least 10 characters.');
    }
    const toStatus = body.action === 'approve' ? 'manager_approved' : 'rejected';
    for (const entryId of body.entry_ids) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE time_entries SET status = $1, updated_at = NOW()
         WHERE id = $2::bigint AND status = 'submitted'`,
        toStatus,
        entryId,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO time_entry_state_history (time_entry_id, from_status, to_status, actor_id, reason)
         VALUES ($1::bigint, 'submitted', $2, $3::bigint, $4)`,
        entryId,
        toStatus,
        actor.userId,
        body.reason ?? null,
      );
      await this.audit.record({
        actorId: actor.userId,
        action: body.action === 'approve' ? 'approval.manager_approve' : 'approval.manager_reject',
        entityType: 'time_entry',
        entityId: entryId,
        before: { status: 'submitted' },
        after: { status: toStatus },
        reason: body.reason,
      });
    }
    // FEAT-002: recompute the affected periods (manager_approved if all reach stage-1; rejected
    // if any entry was rejected). The period status follows its entries.
    await this.recomputeAffectedPeriods(body.entry_ids);
    return { ok: true };
  }

  @Roles('finmgr', 'admin')
  @Post('timesheets/final')
  async finalAction(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(FinalActionSchema)) body: z.infer<typeof FinalActionSchema>,
  ) {
    if (body.action === 'reject' && (!body.reason || body.reason.length < 10)) {
      throw new ValidationFailedError('Reject requires a reason of at least 10 characters.');
    }
    const toStatus = body.action === 'approve' ? 'final_approved' : 'rejected';
    for (const entryId of body.entry_ids) {
      // Invariant: stage-1 actor must NOT equal stage-2 actor on the same entry.
      const stage1 = await this.prisma.$queryRawUnsafe<Array<{ actor_id: unknown }>>(
        `SELECT actor_id FROM time_entry_state_history
         WHERE time_entry_id = $1::bigint AND to_status = 'manager_approved'
         ORDER BY created_at DESC LIMIT 1`,
        entryId,
      );
      if (stage1.length > 0 && String(stage1[0]!.actor_id) === actor.userId) {
        throw new RbacForbiddenError(
          'Two-stage invariant: the same user cannot perform both stage-1 and stage-2 approval on the same entry.',
        );
      }
      await this.prisma.$executeRawUnsafe(
        `UPDATE time_entries SET status = $1, updated_at = NOW()
         WHERE id = $2::bigint AND status = 'manager_approved'`,
        toStatus,
        entryId,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO time_entry_state_history (time_entry_id, from_status, to_status, actor_id, reason)
         VALUES ($1::bigint, 'manager_approved', $2, $3::bigint, $4)`,
        entryId,
        toStatus,
        actor.userId,
        body.reason ?? null,
      );
      await this.audit.record({
        actorId: actor.userId,
        action: body.action === 'approve' ? 'approval.final_approve' : 'approval.final_reject',
        entityType: 'time_entry',
        entityId: entryId,
        before: { status: 'manager_approved' },
        after: { status: toStatus },
        reason: body.reason,
      });
    }
    // FEAT-002: recompute the affected periods (final_approved if all reach stage-2; rejected if
    // any was rejected). Runs only after the loop — a stage1≠stage2 violation throws above and
    // leaves the period at manager_approved (no recompute on a failed transition).
    await this.recomputeAffectedPeriods(body.entry_ids);
    return { ok: true };
  }

  @Roles('admin')
  @Post('admin-unlock/:entryId')
  async adminUnlock(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(AdminUnlockSchema)) body: z.infer<typeof AdminUnlockSchema>,
  ) {
    if (!body.reason || body.reason.length < 20) {
      throw new ValidationFailedError('Reason must be at least 20 characters');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE time_entries SET status = 'draft', updated_at = NOW() WHERE id = $1::bigint`,
      entryId,
    );
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO time_entry_state_history (time_entry_id, from_status, to_status, actor_id, reason)
       VALUES ($1::bigint, 'final_approved', 'draft', $2::bigint, $3)`,
      entryId,
      actor.userId,
      body.reason,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'approval.admin_unlock',
      entityType: 'time_entry',
      entityId: entryId,
      before: { status: 'final_approved' },
      after: { status: 'draft' },
      reason: body.reason,
    });
    // FEAT-002 (D4 reopen mechanism): the entry just dropped to draft, so the period now has a
    // <submitted member and recomputes to 'open' with reopened_at set. Writes are accepted again.
    await this.recomputeAffectedPeriods([entryId]);
    return { ok: true };
  }
}
