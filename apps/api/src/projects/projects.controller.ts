import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/roles.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, RbacScopeService } from '@harvoost/shared';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { AuditService } from '../common/audit/audit.service';

const CreateProjectSchema = z.object({
  client_id: z.string(),
  code: z.string().optional(),
  name: z.string().min(1).max(200),
  billing_mode: z.enum(['hourly', 'fixed_fee', 'non_billable']),
  fixed_fee_amount: z.number().optional(),
  currency: z.string().length(3),
  hours_budget: z.number().optional(),
  department: z.string().optional(),
});

@Controller('v1/projects')
export class ProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload, @Query('page') page = '1', @Query('page_size') pageSize = '50') {
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const offset = (p - 1) * ps;
    const visible = await this.rbac.getVisibleProjectIds(user.userId);
    const params: unknown[] = [ps, offset];
    let where = `is_active = TRUE`;
    if (!visible.unrestricted) {
      params.push(visible.projectIds);
      where += ` AND id = ANY($${params.length}::bigint[])`;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, client_id, code, name, billing_mode, currency, is_active, created_at
       FROM projects WHERE ${where} ORDER BY name LIMIT $1::int OFFSET $2::int`,
      ...params,
    );
    return { data: rows, page: p, page_size: ps };
  }

  @Get(':id')
  async getOne(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    await this.rbac.assertCanSeeProject(user.userId, id);
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, client_id, code, name, billing_mode, currency, fixed_fee_amount, hours_budget, department, is_active
       FROM projects WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (rows.length === 0) throw new NotFoundError();
    return rows[0];
  }

  @Roles('admin')
  @Post()
  async create(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(CreateProjectSchema)) body: z.infer<typeof CreateProjectSchema>,
  ) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `INSERT INTO projects (client_id, code, name, billing_mode, fixed_fee_amount, currency, hours_budget, department, is_active)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING id`,
      body.client_id,
      body.code ?? null,
      body.name,
      body.billing_mode,
      body.fixed_fee_amount ?? null,
      body.currency,
      body.hours_budget ?? null,
      body.department ?? null,
    );
    const newId = String(rows[0]!.id);
    await this.audit.record({
      actorId: actor.userId,
      action: 'project.create',
      entityType: 'project',
      entityId: newId,
      after: body,
    });
    return { id: newId };
  }

  @Roles('admin')
  @Patch(':id')
  async update(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    // TODO(build-phase-followup): strict whitelist of editable fields + rate history rules.
    const fields: string[] = [];
    const params: unknown[] = [];
    const after: Record<string, unknown> = {};
    for (const k of ['name', 'code', 'billing_mode', 'fixed_fee_amount', 'currency', 'hours_budget', 'department', 'is_active']) {
      if (k in body) {
        params.push(body[k]);
        fields.push(`${k} = $${params.length}`);
        after[k] = body[k];
      }
    }
    if (fields.length === 0) return { ok: true };
    params.push(id);
    await this.prisma.$executeRawUnsafe(
      `UPDATE projects SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length}::bigint`,
      ...params,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: after.is_active === false ? 'project.archive' : 'project.update',
      entityType: 'project',
      entityId: id,
      after,
    });
    return { ok: true };
  }

  @Roles('admin')
  @Post(':id/members')
  async assignMember(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body() body: { user_id: string }) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO project_members (project_id, user_id) VALUES ($1::bigint, $2::bigint)
       ON CONFLICT DO NOTHING`,
      id,
      body.user_id,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'project.member_add',
      entityType: 'project',
      entityId: id,
      after: { user_id: body.user_id },
    });
    return { ok: true };
  }

  @Roles('admin')
  @Post(':id/managers')
  async assignManager(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string, @Body() body: { manager_id: string }) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO project_managers (project_id, manager_id) VALUES ($1::bigint, $2::bigint)
       ON CONFLICT DO NOTHING`,
      id,
      body.manager_id,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'project.manager_add',
      entityType: 'project',
      entityId: id,
      after: { manager_id: body.manager_id },
    });
    return { ok: true };
  }
}
