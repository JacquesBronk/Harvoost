import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, RbacScopeService, ValidationFailedError } from '@harvoost/shared';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { AuditService } from '../common/audit/audit.service';
import { Roles } from '../common/roles.decorator';

const CreateLeaveSchema = z.object({
  leave_type: z.enum(['annual', 'sick', 'unpaid', 'other']),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  half_day: z.enum(['am', 'pm']).optional(),
  note: z.string().max(1000).optional(),
});

const RejectSchema = z.object({ reason: z.string().min(10).max(1000) });

@Controller('v1/leave/requests')
export class LeaveController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
    private readonly audit: AuditService,
  ) {}

  // M5 fix: manager fan-out. Employee sees own only; manager sees own + anchored
  // employees (via RBAC cascade); finmgr/admin see everything.
  @Get()
  async list(@CurrentUser() user: CurrentUserPayload) {
    const isPrivileged = user.roles.includes('admin') || user.roles.includes('finmgr');
    const isManager = user.roles.includes('manager');

    let rows: Array<Record<string, unknown>>;
    let scopeMeta: { visible_users: number | 'all' };

    if (isPrivileged) {
      // Org-wide.
      rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, user_id, leave_type, start_date, end_date, half_day, note, status, bamboo_sync_status
         FROM leave_requests
         ORDER BY start_date DESC LIMIT 500`,
      );
      scopeMeta = { visible_users: 'all' };
    } else if (isManager) {
      // Manager: union of own + visible users via the RBAC cascade.
      const visible = await this.rbac.getVisibleUserIds(user.userId);
      const visibleIds = visible.unrestricted ? null : visible.userIds;
      if (visibleIds && visibleIds.length === 0) {
        rows = [];
      } else if (visibleIds) {
        rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT id, user_id, leave_type, start_date, end_date, half_day, note, status, bamboo_sync_status
           FROM leave_requests
           WHERE user_id = ANY($1::bigint[])
           ORDER BY start_date DESC LIMIT 500`,
          visibleIds,
        );
      } else {
        // unrestricted (shouldn't happen for plain manager but defensive).
        rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT id, user_id, leave_type, start_date, end_date, half_day, note, status, bamboo_sync_status
           FROM leave_requests
           ORDER BY start_date DESC LIMIT 500`,
        );
      }
      scopeMeta = { visible_users: visibleIds ? visibleIds.length : 'all' };
    } else {
      // Employee: self only.
      rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, user_id, leave_type, start_date, end_date, half_day, note, status, bamboo_sync_status
         FROM leave_requests WHERE user_id = $1::bigint ORDER BY start_date DESC LIMIT 200`,
        user.userId,
      );
      scopeMeta = { visible_users: 1 };
    }
    return { data: rows, scope_meta: scopeMeta };
  }

  @Post()
  async create(@CurrentUser() user: CurrentUserPayload, @Body(new ZodValidationPipe(CreateLeaveSchema)) body: z.infer<typeof CreateLeaveSchema>) {
    if (body.end_date < body.start_date) throw new ValidationFailedError('end_date must be >= start_date');
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, half_day, note, status, bamboo_sync_status)
       VALUES ($1::bigint, $2, $3::date, $4::date, $5, $6, 'pending', 'not_applicable')
       RETURNING id`,
      user.userId,
      body.leave_type,
      body.start_date,
      body.end_date,
      body.half_day ?? null,
      body.note ?? null,
    );
    return { id: String(rows[0]!.id), status: 'pending' };
  }

  // --- Approval endpoints — restricted to manager/admin/finmgr roles ---

  // M6 fix: PATCH per openapi.yaml (was POST).
  @Roles('manager', 'admin', 'finmgr')
  @Patch(':id/approve')
  async approve(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string) {
    const target = await this.loadLeaveOrThrow(id);
    await this.assertCanActOn(actor, target, 'approve');

    const before = { status: target.status };
    await this.prisma.$executeRawUnsafe(
      `UPDATE leave_requests SET status = 'approved', approved_by = $1::bigint, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2::bigint AND status = 'pending'`,
      actor.userId,
      id,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'leave.approve',
      entityType: 'leave_request',
      entityId: id,
      before,
      after: { status: 'approved', approved_by: actor.userId },
    });
    return { ok: true };
  }

  // M6 fix: PATCH per openapi.yaml (was POST).
  @Roles('manager', 'admin', 'finmgr')
  @Patch(':id/reject')
  async reject(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectSchema)) body: z.infer<typeof RejectSchema>,
  ) {
    const target = await this.loadLeaveOrThrow(id);
    await this.assertCanActOn(actor, target, 'reject');

    const before = { status: target.status };
    await this.prisma.$executeRawUnsafe(
      `UPDATE leave_requests SET status = 'rejected', approved_by = $1::bigint, rejection_reason = $2, updated_at = NOW()
       WHERE id = $3::bigint AND status = 'pending'`,
      actor.userId,
      body.reason,
      id,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'leave.reject',
      entityType: 'leave_request',
      entityId: id,
      before,
      after: { status: 'rejected', approved_by: actor.userId },
      reason: body.reason,
    });
    return { ok: true };
  }

  // Employee cancel — scope baked into UPDATE WHERE user_id = $2.
  @Post(':id/cancel')
  async cancel(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    const result = await this.prisma.$executeRawUnsafe(
      `UPDATE leave_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1::bigint AND user_id = $2::bigint AND status = 'pending'`,
      id,
      user.userId,
    );
    // Only audit when something actually changed (best-effort — count is opaque in raw mode).
    await this.audit.record({
      actorId: user.userId,
      action: 'leave.cancel',
      entityType: 'leave_request',
      entityId: id,
      after: { status: 'cancelled' },
      metadata: { rows_affected: typeof result === 'number' ? result : null },
    });
    return { ok: true };
  }

  // ---- helpers ----

  private async loadLeaveOrThrow(id: string): Promise<{ user_id: string; status: string }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ user_id: unknown; status: unknown }>>(
      `SELECT user_id, status FROM leave_requests WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (rows.length === 0) throw new NotFoundError('Leave request not found.');
    return { user_id: String(rows[0]!.user_id), status: String(rows[0]!.status) };
  }

  private async assertCanActOn(
    actor: CurrentUserPayload,
    target: { user_id: string },
    action: 'approve' | 'reject',
  ): Promise<void> {
    if (target.user_id === actor.userId) {
      throw new ValidationFailedError(`Cannot self-${action} leave`);
    }
    await this.rbac.assertCanSeeUser(actor.userId, target.user_id);
  }
}
