import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, RbacForbiddenError, RbacScopeService } from '@harvoost/shared';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { AuditService } from '../common/audit/audit.service';

@Controller('v1/exceptions')
export class ExceptionsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload, @Query('date_from') from?: string, @Query('date_to') to?: string) {
    const visible = await this.rbac.getVisibleUserIds(user.userId);
    const userIds = visible.unrestricted ? null : visible.userIds;
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (userIds) {
      params.push(userIds);
      wheres.push(`user_id = ANY($${params.length}::bigint[])`);
    }
    if (from) {
      params.push(from);
      wheres.push(`local_date >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      wheres.push(`local_date <= $${params.length}::date`);
    }
    const sql = `SELECT id, user_id, exception_type, local_date, status, details, created_at
                 FROM exceptions ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''}
                 ORDER BY local_date DESC LIMIT 200`;
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
    return { data: rows };
  }

  // M6 fix: POST per openapi.yaml (was PATCH).
  @Post(':id/resolve')
  async resolve(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body() body: { note?: string }) {
    // RBAC: per REQUIREMENTS § F8.1, the v1 default is SELF-RESOLVE only.
    // The exception must belong to the actor. Other roles cannot mark someone else's
    // exception resolved (which would hide overtime / missed-punch / anomaly flags from managers).
    const rows = await this.prisma.$queryRawUnsafe<Array<{ user_id: unknown; status: unknown; exception_type: unknown }>>(
      `SELECT user_id, status, exception_type FROM exceptions WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (rows.length === 0) throw new NotFoundError('Exception not found.');
    const target = rows[0]!;
    const ownerId = String(target.user_id);
    if (ownerId !== actor.userId) {
      throw new RbacForbiddenError('Exceptions can only be resolved by the affected employee (self-resolve).');
    }

    const before = { status: String(target.status) };
    await this.prisma.$executeRawUnsafe(
      `UPDATE exceptions SET status = 'resolved', resolved_by = $1::bigint, resolved_at = NOW(), resolution_note = $2
       WHERE id = $3::bigint AND status = 'open'`,
      actor.userId,
      body.note ?? null,
      id,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'exception.resolve',
      entityType: 'exception',
      entityId: id,
      before,
      after: { status: 'resolved', resolved_by: actor.userId },
      reason: body.note,
      metadata: { exception_type: String(target.exception_type) },
    });
    return { ok: true };
  }
}
