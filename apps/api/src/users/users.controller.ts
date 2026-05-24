import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/roles.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, type RbacScopeService } from '@harvoost/shared';
import { AuditService } from '../common/audit/audit.service';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';

const RoleSchema = z.object({ role: z.enum(['admin', 'finmgr', 'manager', 'employee']) });

@Controller('v1/users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
  ) {}

  @Roles('admin')
  @Get()
  async list(@Query('page') page = '1', @Query('page_size') pageSize = '50') {
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const offset = (p - 1) * ps;
    // INC-006: include `roles` per user (mirror GET /v1/auth/me). Aggregated in a
    // single query via LEFT JOIN + array_agg — NO N+1. The FILTER clause drops the
    // NULL produced for users with zero roles so they yield '{}' (empty array),
    // never [null]; COALESCE handles the all-NULL group. Pagination/order unchanged.
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT u.id, u.email, u.display_name, u.timezone, u.weekly_summary_opt_out, u.is_active, u.created_at,
              COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       GROUP BY u.id
       ORDER BY u.display_name LIMIT $1::int OFFSET $2::int`,
      ps,
      offset,
    );
    // Normalize roles to a clean string[] (String()-mapped, mirroring /v1/auth/me).
    const data = rows.map((row) => ({
      ...row,
      roles: Array.isArray(row.roles) ? row.roles.map((r) => String(r)) : [],
    }));
    const total = await this.prisma.$queryRawUnsafe<Array<{ c: unknown }>>(`SELECT COUNT(*)::int AS c FROM users`);
    return { data, page: p, page_size: ps, total_count: Number(total[0]?.c ?? 0) };
  }

  @Get(':id')
  async getOne(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string) {
    // M4 fix — scope-check non-self lookups. Self is always allowed; otherwise
    // the requester must have RBAC visibility into the target (admin/finmgr are
    // unrestricted; managers see their cascade scope; employees see only self).
    if (id !== actor.userId) {
      await this.rbac.assertCanSeeUser(actor.userId, id);
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, email, display_name, timezone, is_active FROM users WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (rows.length === 0) throw new NotFoundError();
    return rows[0];
  }

  @Roles('admin')
  @Post(':id/roles')
  async assignRole(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body(new ZodValidationPipe(RoleSchema)) body: z.infer<typeof RoleSchema>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO user_roles (user_id, role, assigned_by)
       VALUES ($1::bigint, $2, $3::bigint)
       ON CONFLICT (user_id, role) DO NOTHING`,
      id,
      body.role,
      actor.userId,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'user.role_grant',
      entityType: 'user',
      entityId: id,
      after: { role: body.role },
    });
    return { ok: true };
  }

  @Roles('admin')
  @Delete(':id/roles/:role')
  async removeRole(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Param('role') role: string) {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM user_roles WHERE user_id = $1::bigint AND role = $2`,
      id,
      role,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'user.role_revoke',
      entityType: 'user',
      entityId: id,
      before: { role },
    });
    return { ok: true };
  }

  @Patch(':id')
  async updateUser(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body() body: { timezone?: string; weekly_summary_opt_out?: boolean; display_name?: string }) {
    // Self can edit own timezone + opt_out; admin can edit anyone's display_name.
    const isAdmin = actor.roles.includes('admin');
    if (id !== actor.userId && !isAdmin) throw new NotFoundError();
    const fields: string[] = [];
    const params: unknown[] = [];
    const after: Record<string, unknown> = {};
    if (body.timezone !== undefined) {
      params.push(body.timezone);
      fields.push(`timezone = $${params.length}`);
      after.timezone = body.timezone;
    }
    if (body.weekly_summary_opt_out !== undefined) {
      params.push(body.weekly_summary_opt_out);
      fields.push(`weekly_summary_opt_out = $${params.length}`);
      after.weekly_summary_opt_out = body.weekly_summary_opt_out;
    }
    if (body.display_name !== undefined && isAdmin) {
      params.push(body.display_name);
      fields.push(`display_name = $${params.length}`);
      after.display_name = body.display_name;
    }
    if (fields.length === 0) return { ok: true };
    params.push(id);
    await this.prisma.$executeRawUnsafe(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length}::bigint`,
      ...params,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      after,
    });
    return { ok: true };
  }
}
