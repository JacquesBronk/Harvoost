import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, RbacForbiddenError, RbacScopeService, ValidationFailedError } from '@harvoost/shared';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { AuditService } from '../common/audit/audit.service';
import { Roles } from '../common/roles.decorator';

const UpdateTemplateSchema = z.object({
  working_days: z.array(z.number().int().min(1).max(7)).optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  lunch_start_time: z.string().optional(),
  lunch_end_time: z.string().optional(),
});

// Broad schedule overrides per REQUIREMENTS F7.3.
// - scope=user:    manager-within-scope OR admin/finmgr. target_id REQUIRED.
// - scope=project: admin/finmgr ONLY. target_id (project_id) REQUIRED.
// - scope=org:     admin/finmgr ONLY. target_id forbidden.
// Conflict resolution: same-scope overlapping windows for the same target are
// rejected at create time via the so_no_overlap GIST exclusion in the schema.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // 24-hour HH:MM

const CreateOverrideSchema = z
  .object({
    scope: z.enum(['user', 'project', 'org']),
    target_id: z.string().regex(/^\d+$/).optional(),
    date_range: z.object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    new_start: z.string().regex(TIME_RE),
    new_end: z.string().regex(TIME_RE),
    new_lunch: z
      .object({
        start: z.string().regex(TIME_RE),
        end: z.string().regex(TIME_RE),
      })
      .optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

@Controller('v1/schedules')
export class SchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  async getMine(@CurrentUser() user: CurrentUserPayload) {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT working_days, start_time, end_time, lunch_start_time, lunch_end_time
       FROM schedule_templates WHERE user_id = $1::bigint LIMIT 1`,
      user.userId,
    );
    return rows[0] ?? { working_days: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '17:00' };
  }

  @Patch('me')
  async updateMine(@CurrentUser() user: CurrentUserPayload, @Body(new ZodValidationPipe(UpdateTemplateSchema)) body: z.infer<typeof UpdateTemplateSchema>) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO schedule_templates (user_id, working_days, start_time, end_time, lunch_start_time, lunch_end_time)
       VALUES ($1::bigint, COALESCE($2, ARRAY[1,2,3,4,5]), COALESCE($3, '08:00'), COALESCE($4, '17:00'), $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         working_days = COALESCE($2, schedule_templates.working_days),
         start_time = COALESCE($3, schedule_templates.start_time),
         end_time = COALESCE($4, schedule_templates.end_time),
         lunch_start_time = COALESCE($5, schedule_templates.lunch_start_time),
         lunch_end_time = COALESCE($6, schedule_templates.lunch_end_time),
         updated_at = NOW()`,
      user.userId,
      body.working_days ?? null,
      body.start_time ?? null,
      body.end_time ?? null,
      body.lunch_start_time ?? null,
      body.lunch_end_time ?? null,
    );
    await this.audit.record({
      actorId: user.userId,
      action: 'schedule.template_update',
      entityType: 'schedule_template',
      entityId: user.userId,
      after: body,
    });
    return { ok: true };
  }

  @Get('users/:id')
  async getForUser(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string) {
    if (id !== actor.userId) await this.rbac.assertCanSeeUser(actor.userId, id);
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT working_days, start_time, end_time, lunch_start_time, lunch_end_time
       FROM schedule_templates WHERE user_id = $1::bigint LIMIT 1`,
      id,
    );
    if (rows.length === 0) throw new NotFoundError();
    return rows[0];
  }

  // ---------------- Schedule overrides (F7.3) -------------------------------

  // List overrides — scope-filtered. Employees see only their own user-scoped
  // overrides; managers see their visible-users + project + org; admin/finmgr
  // see everything.
  @Get('overrides')
  async listOverrides(
    @CurrentUser() actor: CurrentUserPayload,
    @Query('scope') scope?: 'user' | 'project' | 'org',
    @Query('target_id') targetId?: string,
  ) {
    const isPrivileged = actor.roles.includes('admin') || actor.roles.includes('finmgr');
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (scope) {
      params.push(scope);
      wheres.push(`scope = $${params.length}`);
    }
    if (targetId) {
      if (scope === 'project') {
        params.push(targetId);
        wheres.push(`project_id = $${params.length}::bigint`);
      } else if (scope === 'user') {
        params.push(targetId);
        wheres.push(`user_id = $${params.length}::bigint`);
      }
    }
    if (!isPrivileged) {
      // Restrict to visible users + their projects.
      const vu = await this.rbac.getVisibleUserIds(actor.userId);
      const vp = await this.rbac.getVisibleProjectIds(actor.userId);
      const userIds = vu.unrestricted ? null : vu.userIds;
      const projectIds = vp.unrestricted ? null : vp.projectIds;
      const scopeOr: string[] = [];
      if (userIds && userIds.length > 0) {
        params.push(userIds);
        scopeOr.push(`(scope = 'user' AND user_id = ANY($${params.length}::bigint[]))`);
      }
      if (projectIds && projectIds.length > 0) {
        params.push(projectIds);
        scopeOr.push(`(scope = 'project' AND project_id = ANY($${params.length}::bigint[]))`);
      }
      // Non-privileged users do NOT see org-scoped overrides via this filter
      // (they're advisory and surface via the calendar view).
      if (scopeOr.length > 0) {
        wheres.push(`(${scopeOr.join(' OR ')})`);
      } else {
        wheres.push('FALSE');
      }
    }
    const sql = `SELECT id, scope, user_id, project_id, effective_from, effective_to,
                        start_time, end_time, lunch_start_time, lunch_end_time, reason,
                        created_by, created_at
                 FROM schedule_overrides
                 ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''}
                 ORDER BY effective_from DESC, id DESC LIMIT 500`;
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
    return { data: rows };
  }

  // POST /v1/schedules/overrides — create a scoped override.
  @Post('overrides')
  async createOverride(
    @CurrentUser() actor: CurrentUserPayload,
    @Body(new ZodValidationPipe(CreateOverrideSchema)) body: z.infer<typeof CreateOverrideSchema>,
  ) {
    const isPrivileged = actor.roles.includes('admin') || actor.roles.includes('finmgr');
    const isManager = actor.roles.includes('manager');

    if (body.date_range.end < body.date_range.start) {
      throw new ValidationFailedError('date_range.end must be >= start');
    }
    if (body.new_end <= body.new_start) {
      throw new ValidationFailedError('new_end must be > new_start');
    }
    if (body.new_lunch && body.new_lunch.end <= body.new_lunch.start) {
      throw new ValidationFailedError('new_lunch.end must be > new_lunch.start');
    }

    // Scope-specific RBAC.
    let userIdParam: string | null = null;
    let projectIdParam: string | null = null;
    if (body.scope === 'user') {
      if (!body.target_id) throw new ValidationFailedError('target_id required for scope=user');
      if (!isPrivileged) {
        if (!isManager) throw new RbacForbiddenError('Only manager+/finmgr/admin can create user-scope overrides.');
        await this.rbac.assertCanSeeUser(actor.userId, body.target_id);
      }
      userIdParam = body.target_id;
    } else if (body.scope === 'project') {
      if (!body.target_id) throw new ValidationFailedError('target_id required for scope=project');
      if (!isPrivileged) {
        throw new RbacForbiddenError('Only admin/finmgr can create project-scope overrides.');
      }
      projectIdParam = body.target_id;
    } else {
      // org
      if (body.target_id) throw new ValidationFailedError('target_id must be omitted for scope=org');
      if (!isPrivileged) {
        throw new RbacForbiddenError('Only admin/finmgr can create org-scope overrides.');
      }
    }

    // Insert. The so_no_overlap GIST exclusion in the schema rejects same-scope
    // overlapping windows; map that 23P01 to a clean 409 here.
    let id: string;
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
        `INSERT INTO schedule_overrides
           (scope, user_id, project_id, effective_from, effective_to,
            start_time, end_time, lunch_start_time, lunch_end_time, reason, created_by)
         VALUES ($1, $2::bigint, $3::bigint, $4::date, $5::date,
                 $6::time, $7::time, $8::time, $9::time, $10, $11::bigint)
         RETURNING id`,
        body.scope,
        userIdParam,
        projectIdParam,
        body.date_range.start,
        body.date_range.end,
        body.new_start,
        body.new_end,
        body.new_lunch?.start ?? null,
        body.new_lunch?.end ?? null,
        body.reason,
        actor.userId,
      );
      id = String(rows[0]!.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/23P01|exclusion_violation|so_no_overlap/i.test(message)) {
        throw new ValidationFailedError(
          'Conflicting schedule override exists for the same scope+target.',
          { code: 'SCHEDULE_OVERRIDE_CONFLICT' },
        );
      }
      throw err;
    }

    await this.audit.record({
      actorId: actor.userId,
      action: 'schedule.override_create',
      entityType: 'schedule_override',
      entityId: id,
      after: {
        scope: body.scope,
        target_id: body.target_id ?? null,
        date_range: body.date_range,
        new_start: body.new_start,
        new_end: body.new_end,
        new_lunch: body.new_lunch ?? null,
      },
      reason: body.reason,
    });
    return { id, scope: body.scope };
  }

  // DELETE /v1/schedules/overrides/:id — remove a scoped override.
  // RBAC: same gate as creation (scope=user → manager+; scope=project|org → admin/finmgr).
  @Delete('overrides/:id')
  async deleteOverride(@CurrentUser() actor: CurrentUserPayload, @Param('id') id: string) {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ scope: unknown; user_id: unknown; project_id: unknown }>
    >(
      `SELECT scope, user_id, project_id FROM schedule_overrides WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (rows.length === 0) throw new NotFoundError('Override not found');
    const o = rows[0]!;
    const scope = String(o.scope);
    const isPrivileged = actor.roles.includes('admin') || actor.roles.includes('finmgr');
    const isManager = actor.roles.includes('manager');

    if (scope === 'user') {
      if (!isPrivileged) {
        if (!isManager) throw new RbacForbiddenError('Manager+/finmgr/admin role required.');
        await this.rbac.assertCanSeeUser(actor.userId, String(o.user_id));
      }
    } else if (scope === 'project' || scope === 'org') {
      if (!isPrivileged) {
        throw new RbacForbiddenError('Admin/finmgr role required for project/org overrides.');
      }
    }

    await this.prisma.$executeRawUnsafe(
      `DELETE FROM schedule_overrides WHERE id = $1::bigint`,
      id,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'schedule.override_delete',
      entityType: 'schedule_override',
      entityId: id,
      before: {
        scope,
        user_id: o.user_id ? String(o.user_id) : null,
        project_id: o.project_id ? String(o.project_id) : null,
      },
    });
    return { ok: true };
  }
}
