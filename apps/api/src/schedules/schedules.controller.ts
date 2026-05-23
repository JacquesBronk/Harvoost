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

// Broad schedule overrides per REQUIREMENTS F7.3 (target identified by
// `user_id`/`project_id` per the spec — INC-004 Row 6).
// - scope=user:    manager-within-scope OR admin/finmgr. user_id REQUIRED.
// - scope=project: admin/finmgr ONLY. project_id REQUIRED.
// - scope=org:     admin/finmgr ONLY. user_id/project_id forbidden.
// Conflict resolution: same-scope overlapping windows for the same target are
// rejected at create time via the so_no_overlap GIST exclusion in the schema.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // 24-hour HH:MM

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// INC-004 Row 6: the create-override body now follows the canonical
// `CreateScheduleOverrideRequest` shape (openapi.yaml) that the FE sends:
// `effective_from`/`effective_to`/`start_time`/`end_time`/`lunch_*`/`user_id`/
// `project_id`. Only `scope`/`effective_from`/`effective_to` are required (per
// spec); the times + reason are optional. The DB columns `start_time`,
// `end_time`, `lunch_start_time`, `lunch_end_time` are nullable, so an override
// can carry just an effective-date window.
const CreateOverrideSchema = z
  .object({
    scope: z.enum(['user', 'project', 'org']),
    user_id: z.string().regex(/^\d+$/).optional(),
    project_id: z.string().regex(/^\d+$/).optional(),
    effective_from: z.string().regex(DATE_ONLY_RE),
    effective_to: z.string().regex(DATE_ONLY_RE),
    start_time: z.string().regex(TIME_RE).optional(),
    end_time: z.string().regex(TIME_RE).optional(),
    lunch_start_time: z.string().regex(TIME_RE).optional(),
    lunch_end_time: z.string().regex(TIME_RE).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

// --- schedules/dashboard helpers (INC-004 Row 3) ---------------------------

// Enumerate inclusive [from, to] as YYYY-MM-DD strings (UTC-based; the dates
// are calendar dates, not timestamps, so no timezone skew applies).
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

// ISO weekday 1=Mon..7=Sun for a YYYY-MM-DD date.
function isoWeekday(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return dow === 0 ? 7 : dow;
}

// True when the override's [effective_from, effective_to] (inclusive) covers
// the given date. effective_* are Date objects or YYYY-MM-DD strings.
function coversDate(
  o: { effective_from: unknown; effective_to: unknown },
  date: string,
): boolean {
  const from = toDateStr(o.effective_from);
  const to = toDateStr(o.effective_to);
  if (!from || !to) return false;
  return from <= date && date <= to;
}

// Normalise a Date | string DB value to a YYYY-MM-DD string.
function toDateStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// Normalise a Postgres TIME(0) value (HH:MM:SS) or a Date to HH:MM.
function hhmm(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const s = String(v);
  const m = s.match(/^(\d{2}:\d{2})/);
  return m ? m[1]! : null;
}

// Scheduled hours = (end - start) minus the lunch window when both present.
function computeHours(
  start: string,
  end: string,
  lunchStart: string | null,
  lunchEnd: string | null,
): number {
  const span = minutesBetween(start, end);
  let lunch = 0;
  if (lunchStart && lunchEnd) {
    lunch = Math.max(0, minutesBetween(lunchStart, lunchEnd));
  }
  const total = Math.max(0, span - lunch);
  return Number((total / 60).toFixed(2));
}

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return (bh! * 60 + bm!) - (ah! * 60 + am!);
}

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

  // GET /v1/schedules/dashboard?tab=&user_id=&date_from=&date_to=&group_by=
  //
  // INC-004 Row 3: spec-conformant (openapi.yaml:1460-1508). Composes each
  // in-scope user's schedule_template with any covering schedule_overrides into
  // per-user/day shaded-block rows for [date_from, date_to].
  //
  // RBAC (per spec):
  //   - tab=company    → Admin/FinMgr only (403 otherwise); all active users.
  //   - tab=team       → the requester's RBAC scope (getVisibleUserIds).
  //   - tab=individual → requires user_id, and the user must be in scope
  //                      (assertCanSeeUser → 403 otherwise).
  //
  // Override precedence per user/day: a covering user-scope override wins over a
  // covering org-scope override, which wins over the user's template. (Project-
  // scope overrides are not applied in the per-user/day grid — they have no
  // single project dimension in this view.) No cost columns here.
  @Get('dashboard')
  async dashboard(
    @CurrentUser() actor: CurrentUserPayload,
    @Query('tab') tab?: string,
    @Query('user_id') userId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    // group_by is accepted for spec compatibility; the per-user/day grid does
    // not currently re-shape by it.
    @Query('group_by') _groupBy?: string,
  ) {
    if (tab !== 'company' && tab !== 'team' && tab !== 'individual') {
      throw new ValidationFailedError('tab must be one of company|team|individual', { tab: tab ?? null });
    }
    if (!dateFrom || !DATE_ONLY_RE.test(dateFrom)) {
      throw new ValidationFailedError('date_from must be YYYY-MM-DD', { date_from: dateFrom ?? null });
    }
    if (!dateTo || !DATE_ONLY_RE.test(dateTo)) {
      throw new ValidationFailedError('date_to must be YYYY-MM-DD', { date_to: dateTo ?? null });
    }
    if (dateTo < dateFrom) {
      throw new ValidationFailedError('date_to must be >= date_from', { date_from: dateFrom, date_to: dateTo });
    }
    // Cap the window to keep the per-day expansion bounded (≈ 1 year).
    const days = enumerateDates(dateFrom, dateTo);
    if (days.length > 366) {
      throw new ValidationFailedError('date range too large (max 366 days)', { date_from: dateFrom, date_to: dateTo });
    }

    const isPrivileged = actor.roles.includes('admin') || actor.roles.includes('finmgr');

    // Resolve the set of users in scope for this tab.
    const vu = await this.rbac.getVisibleUserIds(actor.userId);
    let userFilterIds: string[] | null; // null = unrestricted (all active users)

    if (tab === 'company') {
      if (!isPrivileged) {
        throw new RbacForbiddenError('Company schedule view is restricted to Admin/FinMgr.');
      }
      userFilterIds = null; // all active users
    } else if (tab === 'individual') {
      if (!userId || !/^\d+$/.test(userId)) {
        throw new ValidationFailedError('user_id is required for tab=individual', { user_id: userId ?? null });
      }
      // 403 unless the requester can see this user.
      if (userId !== actor.userId) {
        await this.rbac.assertCanSeeUser(actor.userId, userId);
      }
      userFilterIds = [userId];
    } else {
      // tab=team → the requester's RBAC scope.
      userFilterIds = vu.unrestricted ? null : vu.userIds;
    }

    // No users in scope → empty grid (not an error).
    if (userFilterIds !== null && userFilterIds.length === 0) {
      return {
        data: [],
        scope_meta: {
          visible_users: vu.unrestricted ? 'all' : vu.userIds.length,
          visible_projects: 0,
        },
      };
    }

    // Templates for the in-scope users (only users that have an active row).
    const tmplParams: unknown[] = [];
    let tmplFilter = 'WHERE u.is_active = TRUE';
    if (userFilterIds !== null) {
      tmplParams.push(userFilterIds);
      tmplFilter += ` AND u.id = ANY($${tmplParams.length}::bigint[])`;
    }
    const templates = await this.prisma.$queryRawUnsafe<
      Array<{
        user_id: unknown;
        display_name: unknown;
        working_days: unknown;
        start_time: unknown;
        end_time: unknown;
        lunch_start_time: unknown;
        lunch_end_time: unknown;
      }>
    >(
      `SELECT u.id AS user_id, u.display_name,
              st.working_days, st.start_time, st.end_time,
              st.lunch_start_time, st.lunch_end_time
       FROM users u
       LEFT JOIN schedule_templates st ON st.user_id = u.id
       ${tmplFilter}
       ORDER BY u.display_name ASC`,
      ...tmplParams,
    );

    // Covering user-scope + org-scope overrides within the window.
    const ovParams: unknown[] = [dateFrom, dateTo];
    let ovUserFilter = '';
    if (userFilterIds !== null) {
      ovParams.push(userFilterIds);
      ovUserFilter = ` AND (so.scope = 'org' OR so.user_id = ANY($${ovParams.length}::bigint[]))`;
    }
    const overrides = await this.prisma.$queryRawUnsafe<
      Array<{
        scope: unknown;
        user_id: unknown;
        effective_from: unknown;
        effective_to: unknown;
        start_time: unknown;
        end_time: unknown;
        lunch_start_time: unknown;
        lunch_end_time: unknown;
        reason: unknown;
      }>
    >(
      `SELECT so.scope, so.user_id, so.effective_from, so.effective_to,
              so.start_time, so.end_time, so.lunch_start_time, so.lunch_end_time, so.reason
       FROM schedule_overrides so
       WHERE so.scope IN ('user', 'org')
         AND so.effective_from <= $2::date
         AND so.effective_to >= $1::date${ovUserFilter}
       ORDER BY so.effective_from DESC`,
      ...ovParams,
    );

    // Index overrides by user (user-scope) and a separate org-scope list.
    const userOverrides = new Map<string, typeof overrides>();
    const orgOverrides: typeof overrides = [];
    for (const o of overrides) {
      if (String(o.scope) === 'org') {
        orgOverrides.push(o);
      } else {
        const uid = String(o.user_id);
        const list = userOverrides.get(uid) ?? [];
        list.push(o);
        userOverrides.set(uid, list);
      }
    }

    const rows: Array<{
      user_id: string;
      user_display_name: string;
      local_date: string;
      scheduled_start: string;
      scheduled_end: string;
      scheduled_hours: number;
      source: 'template' | 'user_override' | 'org_override';
      override_reason: string | null;
    }> = [];

    for (const t of templates) {
      const uid = String(t.user_id);
      const displayName = String(t.display_name);
      // Default working days/template when no explicit row exists.
      const workingDays = Array.isArray(t.working_days)
        ? (t.working_days as unknown[]).map((d) => Number(d))
        : [1, 2, 3, 4, 5];
      const tmplStart = hhmm(t.start_time) ?? '08:00';
      const tmplEnd = hhmm(t.end_time) ?? '17:00';
      const tmplLunchStart = hhmm(t.lunch_start_time);
      const tmplLunchEnd = hhmm(t.lunch_end_time);

      const uOverrides = userOverrides.get(uid) ?? [];

      for (const date of days) {
        // Only emit on working days (ISO weekday 1..7).
        const isoDow = isoWeekday(date);
        if (!workingDays.includes(isoDow)) continue;

        // Precedence: user-scope override > org-scope override > template.
        let start = tmplStart;
        let end = tmplEnd;
        let lunchStart = tmplLunchStart;
        let lunchEnd = tmplLunchEnd;
        let source: 'template' | 'user_override' | 'org_override' = 'template';
        let reason: string | null = null;

        const covering =
          uOverrides.find((o) => coversDate(o, date)) ??
          orgOverrides.find((o) => coversDate(o, date));
        if (covering) {
          const cStart = hhmm(covering.start_time);
          const cEnd = hhmm(covering.end_time);
          // An override with null times is a non-working window for that day.
          if (cStart && cEnd) {
            start = cStart;
            end = cEnd;
            lunchStart = hhmm(covering.lunch_start_time);
            lunchEnd = hhmm(covering.lunch_end_time);
          } else {
            // No scheduled hours on this day under the override.
            start = '00:00';
            end = '00:00';
            lunchStart = null;
            lunchEnd = null;
          }
          source = String(covering.scope) === 'org' ? 'org_override' : 'user_override';
          reason = covering.reason != null ? String(covering.reason) : null;
        }

        const scheduledHours = computeHours(start, end, lunchStart, lunchEnd);
        rows.push({
          user_id: uid,
          user_display_name: displayName,
          local_date: date,
          scheduled_start: start,
          scheduled_end: end,
          scheduled_hours: scheduledHours,
          source,
          override_reason: reason,
        });
      }
    }

    return {
      data: rows,
      scope_meta: {
        visible_users: vu.unrestricted ? 'all' : vu.userIds.length,
        visible_projects: 0,
      },
    };
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

    if (body.effective_to < body.effective_from) {
      throw new ValidationFailedError('effective_to must be >= effective_from');
    }
    if (body.start_time && body.end_time && body.end_time <= body.start_time) {
      throw new ValidationFailedError('end_time must be > start_time');
    }
    if (
      body.lunch_start_time &&
      body.lunch_end_time &&
      body.lunch_end_time <= body.lunch_start_time
    ) {
      throw new ValidationFailedError('lunch_end_time must be > lunch_start_time');
    }

    // Scope-specific RBAC. The scope target arrives as `user_id` (scope=user)
    // or `project_id` (scope=project); scope=org carries neither.
    let userIdParam: string | null = null;
    let projectIdParam: string | null = null;
    if (body.scope === 'user') {
      if (!body.user_id) throw new ValidationFailedError('user_id required for scope=user');
      if (body.project_id) throw new ValidationFailedError('project_id must be omitted for scope=user');
      if (!isPrivileged) {
        if (!isManager) throw new RbacForbiddenError('Only manager+/finmgr/admin can create user-scope overrides.');
        await this.rbac.assertCanSeeUser(actor.userId, body.user_id);
      }
      userIdParam = body.user_id;
    } else if (body.scope === 'project') {
      if (!body.project_id) throw new ValidationFailedError('project_id required for scope=project');
      if (body.user_id) throw new ValidationFailedError('user_id must be omitted for scope=project');
      if (!isPrivileged) {
        throw new RbacForbiddenError('Only admin/finmgr can create project-scope overrides.');
      }
      projectIdParam = body.project_id;
    } else {
      // org
      if (body.user_id || body.project_id) {
        throw new ValidationFailedError('user_id/project_id must be omitted for scope=org');
      }
      if (!isPrivileged) {
        throw new RbacForbiddenError('Only admin/finmgr can create org-scope overrides.');
      }
    }

    // Insert. The so_no_overlap GIST exclusion in the schema rejects same-scope
    // overlapping windows; map that 23P01 to a clean 409 here.
    let row: Record<string, unknown>;
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `INSERT INTO schedule_overrides
           (scope, user_id, project_id, effective_from, effective_to,
            start_time, end_time, lunch_start_time, lunch_end_time, reason, created_by)
         VALUES ($1, $2::bigint, $3::bigint, $4::date, $5::date,
                 $6::time, $7::time, $8::time, $9::time, $10, $11::bigint)
         RETURNING id, scope, user_id, project_id, effective_from, effective_to,
                   start_time, end_time, lunch_start_time, lunch_end_time, reason,
                   created_by, created_at`,
        body.scope,
        userIdParam,
        projectIdParam,
        body.effective_from,
        body.effective_to,
        body.start_time ?? null,
        body.end_time ?? null,
        body.lunch_start_time ?? null,
        body.lunch_end_time ?? null,
        body.reason ?? null,
        actor.userId,
      );
      row = rows[0]!;
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

    const id = String(row.id);
    await this.audit.record({
      actorId: actor.userId,
      action: 'schedule.override_create',
      entityType: 'schedule_override',
      entityId: id,
      after: {
        scope: body.scope,
        user_id: userIdParam,
        project_id: projectIdParam,
        effective_from: body.effective_from,
        effective_to: body.effective_to,
        start_time: body.start_time ?? null,
        end_time: body.end_time ?? null,
        lunch_start_time: body.lunch_start_time ?? null,
        lunch_end_time: body.lunch_end_time ?? null,
      },
      reason: body.reason,
    });
    // Return the created override in the canonical `ScheduleOverride` shape.
    // Times are normalised to HH:MM to match the spec pattern (^\d{2}:\d{2}$);
    // Postgres TIME(0) columns serialise as HH:MM:SS.
    return {
      id,
      scope: String(row.scope),
      user_id: row.user_id != null ? String(row.user_id) : null,
      project_id: row.project_id != null ? String(row.project_id) : null,
      effective_from: toDateStr(row.effective_from),
      effective_to: toDateStr(row.effective_to),
      start_time: hhmm(row.start_time),
      end_time: hhmm(row.end_time),
      lunch_start_time: hhmm(row.lunch_start_time),
      lunch_end_time: hhmm(row.lunch_end_time),
      reason: row.reason != null ? String(row.reason) : null,
      created_by: row.created_by != null ? String(row.created_by) : null,
      created_at: row.created_at != null ? String(row.created_at) : null,
    };
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
