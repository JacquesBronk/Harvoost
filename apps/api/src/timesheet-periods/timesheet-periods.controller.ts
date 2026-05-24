import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RbacScopeService, ValidationFailedError } from '@harvoost/shared';
import { CurrentUser, type CurrentUserPayload } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/dto/zod-validation.pipe';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { PeriodService } from './period.service';

// FEAT-002 (issue #6) — read the period status (backs the FE "week locked?" banner) and the
// admin "unlock week" convenience (loops the existing per-entry admin-unlock; no new authority).

// iso_week wire form is "YYYY-Www" (matches the openapi SubmitTimeEntryRequest.iso_week pattern).
const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;

const ListQuery = z.object({
  user_id: z.string().regex(/^\d+$/).optional(),
  status: z.enum(['open', 'submitted', 'manager_approved', 'final_approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const UnlockWeekSchema = z.object({
  reason: z.string().min(20),
});

interface PeriodRow {
  id: unknown;
  user_id: unknown;
  iso_year: unknown;
  iso_week: unknown;
  week_start_date: unknown;
  status: unknown;
  submitted_at: unknown;
  submitted_by: unknown;
  manager_approved_at: unknown;
  final_approved_at: unknown;
  reopened_at: unknown;
}

@Controller('v1/timesheet-periods')
export class TimesheetPeriodsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodService,
    private readonly audit: AuditService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
  ) {}

  // GET /v1/timesheet-periods — list periods visible to the caller (self + RBAC cascade).
  // Optional ?user_id (must be RBAC-visible), ?status, ?limit. Returns the period rollup rows.
  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    const visible = await this.rbac.getVisibleUserIds(user.userId);
    const params: unknown[] = [];
    const wheres: string[] = [];
    if (q.user_id) {
      // A specific user was requested — assert RBAC visibility (self always passes).
      await this.rbac.assertCanSeeUser(user.userId, q.user_id);
      params.push(q.user_id);
      wheres.push(`tp.user_id = $${params.length}::bigint`);
    } else if (!visible.unrestricted) {
      params.push(visible.userIds);
      wheres.push(`tp.user_id = ANY($${params.length}::bigint[])`);
    }
    if (q.status) {
      params.push(q.status);
      wheres.push(`tp.status = $${params.length}`);
    }
    params.push(q.limit);
    const limitIdx = params.length;
    const sql = `
      SELECT tp.id, tp.user_id, tp.iso_year, tp.iso_week, tp.week_start_date, tp.status,
             tp.submitted_at, tp.submitted_by, tp.manager_approved_at, tp.final_approved_at, tp.reopened_at
      FROM timesheet_periods tp
      ${wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''}
      ORDER BY tp.iso_year DESC, tp.iso_week DESC
      LIMIT $${limitIdx}::int`;
    const rows = await this.prisma.$queryRawUnsafe<PeriodRow[]>(sql, ...params);
    const data = await Promise.all(rows.map((r) => this.shape(r)));
    return { data };
  }

  // GET /v1/timesheet-periods/{iso_week} — the caller's OWN period for that ISO-week.
  // Returns the period row + entry_counts. If no row exists the week is implicitly 'open'
  // (DESIGN §1) — we synthesize an open shell so the FE banner has a stable contract.
  @Get(':iso_week')
  async getOne(@CurrentUser() user: CurrentUserPayload, @Param('iso_week') isoWeekParam: string) {
    const m = ISO_WEEK_RE.exec(isoWeekParam);
    if (!m) throw new ValidationFailedError('iso_week must match YYYY-Www');
    const isoYear = Number(m[1]);
    const isoWeek = Number(m[2]);
    const rows = await this.prisma.$queryRawUnsafe<PeriodRow[]>(
      `SELECT id, user_id, iso_year, iso_week, week_start_date, status,
              submitted_at, submitted_by, manager_approved_at, final_approved_at, reopened_at
       FROM timesheet_periods
       WHERE user_id = $1::bigint AND iso_year = $2::int AND iso_week = $3::int
       LIMIT 1`,
      user.userId,
      isoYear,
      isoWeek,
    );
    if (rows.length === 0) {
      // Implicit open week (no row). Synthesize a stable open shell with live counts.
      const entryCounts = await this.entryCounts(user.userId, isoYear, isoWeek);
      return {
        user_id: user.userId,
        iso_year: isoYear,
        iso_week: isoWeek,
        week_start_date: null,
        status: 'open',
        submitted_at: null,
        submitted_by: null,
        manager_approved_at: null,
        final_approved_at: null,
        reopened_at: null,
        entry_counts: entryCounts,
      };
    }
    return this.shape(rows[0]!);
  }

  // POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock — admin "unlock week" convenience.
  // Loops the EXISTING per-entry admin-unlock logic over every locked entry in the week (same
  // audit/history writes, same reason >= 20, NO new authority), then recomputes the period → open
  // with reopened_at set. Identical audit trail to N manual per-entry admin-unlocks (DESIGN §5).
  @Roles('admin')
  @Post(':user_id/:iso_week/unlock')
  async unlockWeek(
    @CurrentUser() actor: CurrentUserPayload,
    @Param('user_id') userIdParam: string,
    @Param('iso_week') isoWeekParam: string,
    @Body(new ZodValidationPipe(UnlockWeekSchema)) body: z.infer<typeof UnlockWeekSchema>,
  ) {
    if (!/^\d+$/.test(userIdParam)) throw new ValidationFailedError('user_id must be a numeric id');
    const m = ISO_WEEK_RE.exec(isoWeekParam);
    if (!m) throw new ValidationFailedError('iso_week must match YYYY-Www');
    if (!body.reason || body.reason.length < 20) {
      throw new ValidationFailedError('Reason must be at least 20 characters');
    }
    const ownerId = userIdParam;
    const isoYear = Number(m[1]);
    const isoWeek = Number(m[2]);

    const unlockedIds = await this.prisma.$transaction(async (tx) => {
      const txc = tx as unknown as PrismaService;
      const userTz = await this.periods.getUserTz(txc, ownerId);
      // Find every LOCKED entry (submitted/manager_approved/final_approved) whose start_at lands
      // in the target week (owner TZ). These are exactly the entries that hold the lock.
      const locked = await txc.$queryRawUnsafe<Array<{ id: unknown; status: unknown }>>(
        `SELECT id, status FROM time_entries
         WHERE user_id = $1::bigint
           AND status IN ('submitted','manager_approved','final_approved')
           AND EXTRACT(ISOYEAR FROM (start_at AT TIME ZONE $2))::int = $3::int
           AND EXTRACT(WEEK    FROM (start_at AT TIME ZONE $2))::int = $4::int`,
        ownerId,
        userTz,
        isoYear,
        isoWeek,
      );
      const ids: string[] = [];
      for (const row of locked) {
        const entryId = String(row.id);
        const fromStatus = String(row.status);
        // Same per-entry write the admin-unlock endpoint performs: drop to draft + history + audit.
        await txc.$executeRawUnsafe(
          `UPDATE time_entries SET status = 'draft', updated_at = NOW() WHERE id = $1::bigint`,
          entryId,
        );
        await txc.$executeRawUnsafe(
          `INSERT INTO time_entry_state_history (time_entry_id, from_status, to_status, actor_id, reason)
           VALUES ($1::bigint, $2, 'draft', $3::bigint, $4)`,
          entryId,
          fromStatus,
          actor.userId,
          body.reason,
        );
        await this.audit.record({
          actorId: actor.userId,
          action: 'approval.admin_unlock',
          entityType: 'time_entry',
          entityId: entryId,
          before: { status: fromStatus },
          after: { status: 'draft' },
          reason: body.reason,
        });
        ids.push(entryId);
      }
      // Recompute → the week now has draft members ⇒ period drops to 'open', reopened_at set (D4).
      await this.periods.recomputePeriod(txc, ownerId, userTz, isoYear, isoWeek);
      return ids;
    });

    return { unlocked_ids: unlockedIds, user_id: ownerId, iso_year: isoYear, iso_week: isoWeek };
  }

  // Shape a period row + attach live entry_counts.
  private async shape(r: PeriodRow): Promise<Record<string, unknown>> {
    const entryCounts = await this.entryCounts(
      String(r.user_id),
      Number(r.iso_year),
      Number(r.iso_week),
    );
    return {
      id: String(r.id),
      user_id: String(r.user_id),
      iso_year: Number(r.iso_year),
      iso_week: Number(r.iso_week),
      week_start_date: r.week_start_date instanceof Date ? r.week_start_date.toISOString().slice(0, 10) : r.week_start_date,
      status: String(r.status),
      submitted_at: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : r.submitted_at,
      submitted_by: r.submitted_by === null ? null : String(r.submitted_by),
      manager_approved_at: r.manager_approved_at instanceof Date ? r.manager_approved_at.toISOString() : r.manager_approved_at,
      final_approved_at: r.final_approved_at instanceof Date ? r.final_approved_at.toISOString() : r.final_approved_at,
      reopened_at: r.reopened_at instanceof Date ? r.reopened_at.toISOString() : r.reopened_at,
      entry_counts: entryCounts,
    };
  }

  // entry_counts — per-status counts of the user's non-running entries in the ISO-week (owner TZ).
  private async entryCounts(
    userId: string,
    isoYear: number,
    isoWeek: number,
  ): Promise<Record<string, number>> {
    const userTz = await this.periods.getUserTz(this.prisma, userId);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ status: unknown; n: unknown }>>(
      `SELECT status, COUNT(*)::int AS n
       FROM time_entries
       WHERE user_id = $1::bigint
         AND status <> 'running'
         AND EXTRACT(ISOYEAR FROM (start_at AT TIME ZONE $2))::int = $3::int
         AND EXTRACT(WEEK    FROM (start_at AT TIME ZONE $2))::int = $4::int
       GROUP BY status`,
      userId,
      userTz,
      isoYear,
      isoWeek,
    );
    const counts: Record<string, number> = {
      draft: 0,
      submitted: 0,
      manager_approved: 0,
      final_approved: 0,
      rejected: 0,
    };
    for (const r of rows) {
      counts[String(r.status)] = Number(r.n);
    }
    return counts;
  }
}
