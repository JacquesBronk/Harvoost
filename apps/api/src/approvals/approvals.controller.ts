import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RbacForbiddenError, ValidationFailedError } from '@harvoost/shared';
import { Roles } from '../common/roles.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { PeriodService } from '../timesheet-periods/period.service';

const ManagerActionSchema = z.object({
  entry_ids: z.array(z.string()).min(1),
  action: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
});

const FinalActionSchema = ManagerActionSchema;

const AdminUnlockSchema = z.object({
  reason: z.string().min(20),
});

@Controller('v1/approvals')
export class ApprovalsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly periods: PeriodService,
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

  @Get('queue')
  async queue(@CurrentUser() user: CurrentUserPayload, @Query('limit') limit = '50') {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const isFin = user.roles.includes('finmgr');
    const isManager = user.roles.includes('manager') || user.roles.includes('admin');
    const status = isFin ? 'manager_approved' : isManager ? 'submitted' : null;
    if (!status) return { data: [] };
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, user_id, project_id, status, start_at, end_at
       FROM time_entries WHERE status = $1
       ORDER BY start_at DESC LIMIT $2::int`,
      status,
      lim,
    );
    return { data: rows };
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
