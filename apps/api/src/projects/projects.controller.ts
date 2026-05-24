import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/roles.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, RbacScopeService, ValidationFailedError } from '@harvoost/shared';
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

// FEAT-003 (GitHub #16) — project task write contracts. Faithful to openapi.yaml
// CreateProjectTaskRequest / UpdateProjectTaskRequest. The DB `name` column is
// TEXT (no length cap) and the contract only mandates minLength 1; a 200-char
// cap is applied defensively to match the sibling project/client `name` bounds.
export const CreateProjectTaskSchema = z
  .object({
    name: z.string().min(1).max(200),
    is_billable: z.boolean().default(true),
  })
  .strict();

// minProperties: 1 — an empty PATCH is rejected with a 400 (ZodError → 400 via
// the HttpExceptionFilter) rather than the no-op-200 convention. DECISION
// CONFIRMED in the dispatch: empty PATCH → 400.
export const UpdateProjectTaskSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    is_billable: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) => b.name !== undefined || b.is_billable !== undefined || b.is_active !== undefined,
    { message: 'At least one of name, is_billable, or is_active must be provided.' },
  );

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

  // GET /v1/projects/{project_id}/tasks → { data: ProjectTask[] }.
  // Read-only list of tasks within a project (FEAT-001 task picker source).
  // RBAC: project-visibility scoped via RbacScopeService — admin/finmgr see all,
  // others only see projects they're anchored to. A project the requester cannot
  // see (or that does not exist) returns 404, never 403, so existence never leaks.
  // Optional `is_active` (boolean) narrows on project_tasks.is_active when present.
  // bigint ids (id, project_id) are String()-mapped so the wire shape is unambiguous.
  @Get(':project_id/tasks')
  async listTasks(
    @CurrentUser() user: CurrentUserPayload,
    @Param('project_id') projectId: string,
    @Query('is_active') isActive?: string,
  ) {
    // Visibility gate: scoped requesters may only list tasks for a project they
    // can see; non-visible/non-existent both collapse to 404 (no existence leak).
    const visible = await this.rbac.getVisibleProjectIds(user.userId);
    if (!visible.unrestricted && !visible.projectIds.includes(projectId)) {
      throw new NotFoundError();
    }

    // Confirm the project actually exists (covers admin/finmgr unrestricted path
    // and a stale id for a scoped user); a missing project is a 404, not [].
    const projectRows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `SELECT id FROM projects WHERE id = $1::bigint LIMIT 1`,
      projectId,
    );
    if (projectRows.length === 0) throw new NotFoundError();

    // Parse the optional is_active filter. Absent → no filter (all tasks).
    // Anything other than the boolean literals is a clear validation failure.
    const params: unknown[] = [projectId];
    let where = `project_id = $1::bigint`;
    if (isActive !== undefined) {
      let flag: boolean;
      if (isActive === 'true') flag = true;
      else if (isActive === 'false') flag = false;
      else throw new ValidationFailedError('is_active must be a boolean.');
      params.push(flag);
      where += ` AND is_active = $${params.length}::boolean`;
    }

    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, project_id, name, is_billable, is_active
       FROM project_tasks WHERE ${where} ORDER BY name ASC, id ASC`,
      ...params,
    );

    return {
      data: rows.map((r) => ({
        id: String(r.id),
        project_id: String(r.project_id),
        name: String(r.name),
        is_billable: Boolean(r.is_billable),
        is_active: Boolean(r.is_active),
      })),
    };
  }

  // POST /v1/projects/{project_id}/tasks → 201 ProjectTask.
  // Admin/FinMgr per openapi.yaml (createProjectTask) — intentionally WIDER than
  // the sibling admin-only project write routes. Reuses listTasks' visibility/
  // existence 404 gate (non-visible/non-existent project → 404, never a 403/500
  // existence leak). A duplicate ACTIVE name in the same project trips the
  // partial unique index `project_tasks_active_name_unique` (Postgres 23505),
  // which is mapped to a clean domain error (code TASK_NAME_EXISTS) rather than a
  // raw 500 — mirroring the clients/billable-rates constraint-mapping precedent.
  // An ARCHIVED same-name task does NOT block a new active one (index is
  // WHERE is_active = TRUE).
  @Roles('admin', 'finmgr')
  @Post(':project_id/tasks')
  @HttpCode(201)
  async createProjectTask(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateProjectTaskSchema)) body: z.infer<typeof CreateProjectTaskSchema>,
  ) {
    await this.assertProjectVisibleOrThrow(actor.userId, projectId);

    let row: Record<string, unknown>;
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `INSERT INTO project_tasks (project_id, name, is_billable)
         VALUES ($1::bigint, $2, $3::boolean)
         RETURNING id, project_id, name, is_billable, is_active`,
        projectId,
        body.name,
        body.is_billable,
      );
      row = rows[0]!;
    } catch (err) {
      throw this.mapTaskNameConflict(err);
    }

    const task = mapTaskRow(row);
    await this.audit.record({
      actorId: actor.userId,
      action: 'project.task_create',
      entityType: 'project_task',
      entityId: task.id,
      after: { project_id: task.project_id, name: task.name, is_billable: task.is_billable },
    });
    return task;
  }

  // PATCH /v1/projects/{project_id}/tasks/{task_id} → 200 ProjectTask.
  // Admin/FinMgr per openapi.yaml (updateProjectTask). Reuses the visibility/
  // existence 404 gate, AND 404s when the task does not exist or belongs to a
  // different project (the task SELECT is scoped to project_id). Only the
  // provided fields are updated; updated_at is bumped. Empty body → 400 (the
  // schema's minProperties:1 refine throws a ZodError). A rename or reactivation
  // that collides with an existing ACTIVE name in the project trips the partial
  // unique index (23505) → clean domain error (TASK_NAME_EXISTS), not a 500.
  // There is NO DELETE — retirement is PATCH { is_active: false }.
  @Roles('admin', 'finmgr')
  @Patch(':project_id/tasks/:task_id')
  async updateProjectTask(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('project_id') projectId: string,
    @Param('task_id') taskId: string,
    @Body(new ZodValidationPipe(UpdateProjectTaskSchema)) body: z.infer<typeof UpdateProjectTaskSchema>,
  ) {
    await this.assertProjectVisibleOrThrow(actor.userId, projectId);

    // Confirm the task exists AND belongs to this project — a stale/foreign
    // task_id is a 404, never a cross-project leak.
    const existing = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `SELECT id FROM project_tasks WHERE id = $1::bigint AND project_id = $2::bigint LIMIT 1`,
      taskId,
      projectId,
    );
    if (existing.length === 0) throw new NotFoundError();

    // Build the partial UPDATE from only the provided fields.
    const fields: string[] = [];
    const params: unknown[] = [];
    const after: Record<string, unknown> = {};
    if (body.name !== undefined) {
      params.push(body.name);
      fields.push(`name = $${params.length}`);
      after.name = body.name;
    }
    if (body.is_billable !== undefined) {
      params.push(body.is_billable);
      fields.push(`is_billable = $${params.length}::boolean`);
      after.is_billable = body.is_billable;
    }
    if (body.is_active !== undefined) {
      params.push(body.is_active);
      fields.push(`is_active = $${params.length}::boolean`);
      after.is_active = body.is_active;
    }
    // The schema's refine guarantees fields.length >= 1 by this point.
    params.push(taskId);
    params.push(projectId);

    let row: Record<string, unknown>;
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `UPDATE project_tasks SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length - 1}::bigint AND project_id = $${params.length}::bigint
         RETURNING id, project_id, name, is_billable, is_active`,
        ...params,
      );
      row = rows[0]!;
    } catch (err) {
      throw this.mapTaskNameConflict(err);
    }

    const task = mapTaskRow(row);
    // Archive (is_active → false) records a dedicated action for the audit trail;
    // all other field changes record project.task_update.
    const archived = body.is_active === false;
    await this.audit.record({
      actorId: actor.userId,
      action: archived ? 'project.task_archive' : 'project.task_update',
      entityType: 'project_task',
      entityId: task.id,
      after,
    });
    return task;
  }

  // Shared visibility/existence gate for the task write paths — identical
  // semantics to listTasks: a scoped requester who cannot see the project, OR a
  // project that does not exist, both collapse to 404 (no existence leak, never
  // 403/500). Admin/finmgr are unrestricted, so for them the only 404 is a
  // genuinely missing project.
  private async assertProjectVisibleOrThrow(userId: string, projectId: string): Promise<void> {
    const visible = await this.rbac.getVisibleProjectIds(userId);
    if (!visible.unrestricted && !visible.projectIds.includes(projectId)) {
      throw new NotFoundError();
    }
    const projectRows = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `SELECT id FROM projects WHERE id = $1::bigint LIMIT 1`,
      projectId,
    );
    if (projectRows.length === 0) throw new NotFoundError();
  }

  // Map the partial-unique-index violation on (project_id, name) WHERE is_active
  // to a clean domain error. Mirrors the clients (23503) / billable-rates (23P01)
  // constraint-mapping precedent: ValidationFailedError carrying a stable
  // details.code so the wire envelope is { code: VALIDATION_FAILED, message,
  // details: { code: TASK_NAME_EXISTS } } instead of a raw 500. Any other error
  // is re-thrown unchanged.
  private mapTaskNameConflict(err: unknown): unknown {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === '23505' || /23505|project_tasks_active_name_unique|unique constraint/i.test(message)) {
      return new ValidationFailedError(
        'A task with that name already exists in this project.',
        { code: 'TASK_NAME_EXISTS' },
      );
    }
    return err;
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

  // GET /v1/projects/{id}/members → OffsetPaginated<ProjectMember>.
  // Lists CURRENTLY-active members (left_at IS NULL) — mirrors the partial
  // unique index the POST relies on. JOINs users for display_name/email so the
  // admin UI can render names without a second round-trip. Admin-only.
  @Roles('admin')
  @Get(':id/members')
  async listMembers(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('page_size') pageSize = '50',
  ) {
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const offset = (p - 1) * ps;
    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1::bigint AND left_at IS NULL`,
      id,
    );
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT pm.id, pm.project_id, pm.user_id,
              u.display_name AS user_display_name, u.email AS user_email,
              pm.joined_at, pm.left_at
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1::bigint AND pm.left_at IS NULL
       ORDER BY u.display_name ASC, pm.id ASC
       LIMIT $2::int OFFSET $3::int`,
      id,
      ps,
      offset,
    );
    return {
      data: rows.map((r) => ({
        id: String(r.id),
        project_id: String(r.project_id),
        user_id: String(r.user_id),
        user_display_name: r.user_display_name ?? undefined,
        user_email: r.user_email ?? undefined,
        joined_at: r.joined_at,
        left_at: r.left_at ?? null,
      })),
      page: p,
      page_size: ps,
      total_count: Number(totalRows[0]?.n ?? 0),
    };
  }

  // DELETE /v1/projects/{id}/members/{userId} → soft-removes the active
  // membership (left_at = CURRENT_DATE). Soft-delete keeps the audit/history
  // trail AND frees the partial unique index so the same user can be re-added
  // later via POST. Admin-only. Idempotent: no-op if already removed/absent.
  @Roles('admin')
  @Delete(':id/members/:userId')
  async removeMember(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE project_members SET left_at = CURRENT_DATE
       WHERE project_id = $1::bigint AND user_id = $2::bigint AND left_at IS NULL`,
      id,
      userId,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'project.member_remove',
      entityType: 'project',
      entityId: id,
      after: { user_id: userId },
    });
    return { ok: true };
  }

  // GET /v1/projects/{id}/managers → OffsetPaginated<ProjectManagerAnchor>.
  // JOINs users for display_name/email. Admin-only.
  @Roles('admin')
  @Get(':id/managers')
  async listManagers(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('page_size') pageSize = '50',
  ) {
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const offset = (p - 1) * ps;
    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*)::int AS n FROM project_managers WHERE project_id = $1::bigint`,
      id,
    );
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT pmgr.id, pmgr.project_id, pmgr.manager_id,
              u.display_name AS manager_display_name, u.email AS manager_email,
              pmgr.assigned_at
       FROM project_managers pmgr
       JOIN users u ON u.id = pmgr.manager_id
       WHERE pmgr.project_id = $1::bigint
       ORDER BY u.display_name ASC, pmgr.id ASC
       LIMIT $2::int OFFSET $3::int`,
      id,
      ps,
      offset,
    );
    return {
      data: rows.map((r) => ({
        id: String(r.id),
        project_id: String(r.project_id),
        manager_id: String(r.manager_id),
        manager_display_name: r.manager_display_name ?? undefined,
        manager_email: r.manager_email ?? undefined,
        assigned_at: r.assigned_at,
      })),
      page: p,
      page_size: ps,
      total_count: Number(totalRows[0]?.n ?? 0),
    };
  }

  // DELETE /v1/projects/{id}/managers/{managerId} → unanchors a manager.
  // Hard delete (project_managers has no soft-delete column; the unique
  // constraint is on the full row). Admin-only. Idempotent.
  @Roles('admin')
  @Delete(':id/managers/:managerId')
  async removeManager(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') id: string,
    @Param('managerId') managerId: string,
  ) {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM project_managers WHERE project_id = $1::bigint AND manager_id = $2::bigint`,
      id,
      managerId,
    );
    await this.audit.record({
      actorId: actor.userId,
      action: 'project.manager_remove',
      entityType: 'project',
      entityId: id,
      after: { manager_id: managerId },
    });
    return { ok: true };
  }
}

// ProjectTask wire shape — bigint ids String()-mapped, booleans coerced. Matches
// listTasks' row mapping and the openapi.yaml ProjectTask schema exactly.
function mapTaskRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    name: String(r.name),
    is_billable: Boolean(r.is_billable),
    is_active: Boolean(r.is_active),
  };
}
