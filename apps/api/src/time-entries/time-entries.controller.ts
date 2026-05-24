import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { EntryLockedError, IdempotencyConflictError, NotFoundError, ValidationFailedError, RbacScopeService } from '@harvoost/shared';
import { RBAC_SCOPE_SERVICE } from '../rbac/rbac.module';
import { AuditService } from '../common/audit/audit.service';
import { SyncService } from '../sync/sync.service';
import { PeriodService, mapPeriodLockDbError } from '../timesheet-periods/period.service';

const StartSchema = z.object({
  project_id: z.string(),
  task_id: z.string().optional(),
  notes: z.string().max(2000).optional(),
  mood_score: z.number().int().min(1).max(5).optional(),
});

const StopSchema = z.object({
  notes: z.string().max(2000).optional(),
});

const SwitchSchema = z.object({
  project_id: z.string(),
  task_id: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

const ManualEntrySchema = z.object({
  project_id: z.string(),
  task_id: z.string().optional(),
  start_at: z.string(),
  end_at: z.string(),
  notes: z.string().max(2000).optional(),
  billable: z.boolean().optional(),
});

// PATCH /v1/time-entries/:id — strict whitelist. Unknown fields rejected by `.strict()`.
// IDs are string-encoded bigints; we constrain to digits to keep the column types coherent.
// Per Finding 5 (FIX_PLAN.md): a project_id change must additionally pass an RBAC project-scope check.
const PatchEntrySchema = z
  .object({
    notes: z.string().max(2000).nullable().optional(),
    start_at: z.string().datetime().optional(),
    end_at: z.string().datetime().optional(),
    project_id: z.string().regex(/^\d+$/).optional(),
    task_id: z.string().regex(/^\d+$/).nullable().optional(),
    billable: z.boolean().optional(),
  })
  .strict()
  .partial();

// FEAT-002 (issue #6) — submit request. scope defaults to 'entry'; 'week' submits the whole
// ISO-week the entry belongs to (what the FE sends). iso_week overrides the target week.
const SubmitSchema = z.object({
  scope: z.enum(['entry', 'week']).default('entry'),
  iso_week: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
});

const ListQuery = z.object({
  user_id: z.string().optional(),
  project_id: z.string().optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// LOCKED statuses block edits per F2.1.
const LOCKED_STATUSES = new Set(['submitted', 'manager_approved', 'final_approved']);

@Controller('v1/time-entries')
export class TimeEntriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    @Inject(RBAC_SCOPE_SERVICE) private readonly rbac: RbacScopeService,
    private readonly audit: AuditService,
    private readonly sync: SyncService,
    private readonly periods: PeriodService,
  ) {}

  @Get()
  async list(@CurrentUser() user: CurrentUserPayload, @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    // Apply cascade visibility. We always allow self.
    const visibleUsers = await this.rbac.getVisibleUserIds(user.userId);
    const visibleProjects = await this.rbac.getVisibleProjectIds(user.userId);
    const userIds = visibleUsers.unrestricted ? null : visibleUsers.userIds;
    const projectIds = visibleProjects.unrestricted ? null : visibleProjects.projectIds;
    const params: unknown[] = [];
    const wheres: string[] = [`(te.end_at IS NULL OR te.end_at IS NOT NULL)`];
    if (userIds) {
      params.push(userIds);
      wheres.push(`te.user_id = ANY($${params.length}::bigint[])`);
    }
    if (projectIds) {
      params.push(projectIds);
      wheres.push(`te.project_id = ANY($${params.length}::bigint[])`);
    }
    if (q.user_id) {
      params.push(q.user_id);
      wheres.push(`te.user_id = $${params.length}::bigint`);
    }
    if (q.project_id) {
      params.push(q.project_id);
      wheres.push(`te.project_id = $${params.length}::bigint`);
    }
    if (q.date_from) {
      params.push(q.date_from);
      wheres.push(`te.start_at >= $${params.length}::date`);
    }
    if (q.date_to) {
      params.push(q.date_to);
      wheres.push(`te.start_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    params.push(q.limit);
    const limitIdx = params.length;
    const sql = `
      SELECT te.id, te.user_id, te.project_id, te.task_id, te.notes, te.start_at, te.end_at, te.status, te.billable
      FROM time_entries te
      WHERE ${wheres.join(' AND ')}
      ORDER BY te.start_at DESC
      LIMIT $${limitIdx}::int`;
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
    return {
      data: rows.map((r) => normalizeRow(r, user.roles)),
      scope_meta: {
        visible_users: visibleUsers.unrestricted ? -1 : visibleUsers.userIds.length,
        visible_projects: visibleProjects.unrestricted ? -1 : visibleProjects.projectIds.length,
      },
      next_cursor: null,
      prev_cursor: null,
    };
  }

  @Get('running')
  async running(@CurrentUser() user: CurrentUserPayload) {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id, user_id, project_id, task_id, notes, start_at, end_at, status, billable
       FROM time_entries
       WHERE user_id = $1::bigint AND status = 'running'
       LIMIT 1`,
      user.userId,
    );
    return rows.length === 0 ? { data: null } : { data: normalizeRow(rows[0]!, user.roles) };
  }

  @Post('start')
  async start(
    @CurrentUser() user: CurrentUserPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(StartSchema)) body: z.infer<typeof StartSchema>,
  ) {
    if (!idempotencyKey) throw new ValidationFailedError('Idempotency-Key header required.');
    const cached = await this.idempotency.lookup(user.userId, idempotencyKey, body);
    if (cached) return cached;

    // M1 fix: wrap the implicit-stop + new-insert in a single transaction. Without this,
    // a concurrent retry between the two statements can leave the user with two RUNNING
    // entries (caught by the partial unique index te_one_running_per_user but surfaced
    // as a 500). The exclusive index now converts a race into a clean 409.
    let out: Record<string, unknown>;
    try {
      out = await this.prisma.$transaction(async (tx) => {
        // FEAT-002: defensively reject starting a timer whose NOW() lands in a locked current
        // week (possible if the user submitted the in-progress week early). Cheap precheck;
        // the DB trigger (HV001) is the backstop on the INSERT below.
        const userTz = await this.periods.getUserTz(tx, user.userId);
        await this.periods.assertPeriodWritable(tx, user.userId, userTz, new Date());
        await tx.$executeRawUnsafe(
          `UPDATE time_entries SET end_at = NOW(), status = 'draft', updated_at = NOW()
           WHERE user_id = $1::bigint AND status = 'running'`,
          user.userId,
        );
        const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `INSERT INTO time_entries (user_id, project_id, task_id, notes, start_at, status, billable, mood_score, idempotency_key)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4, NOW(), 'running', TRUE, $5, $6)
           RETURNING id, user_id, project_id, task_id, notes, start_at, end_at, status, billable, mood_score`,
          user.userId,
          body.project_id,
          body.task_id ?? null,
          body.notes ?? null,
          body.mood_score ?? null,
          idempotencyKey,
        );
        return normalizeRow(rows[0]!, user.roles);
      });
    } catch (err) {
      // FEAT-002: a concurrent submit may have locked the week between the precheck and the
      // INSERT — the DB trigger rejects with HV001. Map it to a clean 409 PERIOD_LOCKED.
      const mapped = mapPeriodLockDbError(err);
      if (mapped !== err) throw mapped;
      // Race condition: a concurrent start raced this one. Both UPDATEs ran; both INSERTs
      // attempted; one violated te_one_running_per_user. Convert to a clean 409.
      if (isUniqueViolation(err, 'te_one_running_per_user') || isUniqueViolation(err, 'te_idempotency_unique')) {
        throw new IdempotencyConflictError();
      }
      throw err;
    }

    await this.idempotency.store(user.userId, idempotencyKey, body, out);
    // Emit SSE event AFTER the transaction commits so we never push for rolled-back work.
    this.sync.emit(user.userId, { type: 'timer.started', data: out });
    return out;
  }

  @Post('stop')
  async stop(
    @CurrentUser() user: CurrentUserPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(StopSchema)) body: z.infer<typeof StopSchema>,
  ) {
    if (!idempotencyKey) throw new ValidationFailedError('Idempotency-Key header required.');
    const cached = await this.idempotency.lookup(user.userId, idempotencyKey, body);
    if (cached) return cached;
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE time_entries
       SET end_at = NOW(), status = 'draft', updated_at = NOW(),
           notes = COALESCE($2, notes)
       WHERE user_id = $1::bigint AND status = 'running'
       RETURNING id, user_id, project_id, task_id, notes, start_at, end_at, status, billable`,
      user.userId,
      body.notes ?? null,
    );
    if (rows.length === 0) {
      // Idempotent: treat as no-op success.
      const out = { data: null };
      await this.idempotency.store(user.userId, idempotencyKey, body, out);
      return out;
    }
    const out = normalizeRow(rows[0]!, user.roles);
    await this.idempotency.store(user.userId, idempotencyKey, body, out);

    // Enqueue real-time overtime check + emit SSE — both AFTER the row is committed.
    this.sync.emit(user.userId, { type: 'timer.stopped', data: out });
    await this.enqueueOvertimeCheck(user.userId);

    return out;
  }

  @Post('switch')
  async switch(
    @CurrentUser() user: CurrentUserPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(SwitchSchema)) body: z.infer<typeof SwitchSchema>,
  ) {
    if (!idempotencyKey) throw new ValidationFailedError('Idempotency-Key header required.');
    const cached = await this.idempotency.lookup(user.userId, idempotencyKey, body);
    if (cached) return cached;

    // M1 fix: same transactional pattern as start — atomic stop-and-start.
    let out: Record<string, unknown>;
    try {
      out = await this.prisma.$transaction(async (tx) => {
        // FEAT-002: defensively reject a switch whose NOW() lands in a locked current week.
        const userTz = await this.periods.getUserTz(tx, user.userId);
        await this.periods.assertPeriodWritable(tx, user.userId, userTz, new Date());
        await tx.$executeRawUnsafe(
          `UPDATE time_entries SET end_at = NOW(), status = 'draft', updated_at = NOW()
           WHERE user_id = $1::bigint AND status = 'running'`,
          user.userId,
        );
        const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `INSERT INTO time_entries (user_id, project_id, task_id, notes, start_at, status, billable, idempotency_key)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4, NOW(), 'running', TRUE, $5)
           RETURNING id, user_id, project_id, task_id, notes, start_at, end_at, status, billable`,
          user.userId,
          body.project_id,
          body.task_id ?? null,
          body.notes ?? null,
          idempotencyKey,
        );
        return normalizeRow(rows[0]!, user.roles);
      });
    } catch (err) {
      // FEAT-002: map the DB lock trigger (HV001) to a clean 409 PERIOD_LOCKED (TOCTOU backstop).
      const mapped = mapPeriodLockDbError(err);
      if (mapped !== err) throw mapped;
      if (isUniqueViolation(err, 'te_one_running_per_user') || isUniqueViolation(err, 'te_idempotency_unique')) {
        throw new IdempotencyConflictError();
      }
      throw err;
    }

    await this.idempotency.store(user.userId, idempotencyKey, body, out);
    this.sync.emit(user.userId, { type: 'timer.switched', data: out });
    await this.enqueueOvertimeCheck(user.userId);

    return out;
  }

  // FEAT-002 (issue #6) — submit an entry's week (scope='week', what the FE sends) or just the
  // single entry (scope='entry'). Self-only: the entry_id must belong to the caller (else 404,
  // mirroring the PATCH self-check). Flips draft→submitted, writes history rows (actor=owner),
  // skips running ('running') and already-submitted+ ('already_submitted'), and upserts the
  // timesheet_periods row. Returns { submitted_ids, skipped }.
  @Post(':id/submit')
  async submit(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SubmitSchema)) body: z.infer<typeof SubmitSchema>,
  ) {
    // Resolve the anchor entry; self-only.
    const anchor = await this.prisma.$queryRawUnsafe<Array<{ user_id: unknown; status: unknown; start_at: unknown }>>(
      `SELECT user_id, status, start_at FROM time_entries WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (anchor.length === 0) throw new NotFoundError();
    if (String(anchor[0]!.user_id) !== user.userId) throw new NotFoundError(); // uniform 404

    const submittedIds: string[] = [];
    const skipped: Array<{ entry_id: string; reason: string }> = [];

    await this.prisma.$transaction(async (tx) => {
      const userTz = await this.periods.getUserTz(tx, user.userId);

      // Determine the target ISO-week: explicit iso_week override, else the anchor entry's week.
      let isoYear: number;
      let isoWeek: number;
      if (body.scope === 'week' && body.iso_week) {
        const m = /^(\d{4})-W(\d{2})$/.exec(body.iso_week);
        if (!m) throw new ValidationFailedError('iso_week must match YYYY-Www');
        isoYear = Number(m[1]);
        isoWeek = Number(m[2]);
      } else {
        const w = await this.periods.resolveWeek(tx, userTz, anchor[0]!.start_at as string | Date);
        isoYear = w.isoYear;
        isoWeek = w.isoWeek;
      }

      // Candidate entries to submit.
      let candidates: Array<{ id: unknown; status: unknown }>;
      if (body.scope === 'week') {
        candidates = await tx.$queryRawUnsafe<Array<{ id: unknown; status: unknown }>>(
          `SELECT id, status FROM time_entries
           WHERE user_id = $1::bigint
             AND EXTRACT(ISOYEAR FROM (start_at AT TIME ZONE $2))::int = $3::int
             AND EXTRACT(WEEK    FROM (start_at AT TIME ZONE $2))::int = $4::int
           ORDER BY start_at ASC`,
          user.userId,
          userTz,
          isoYear,
          isoWeek,
        );
      } else {
        // scope='entry' — just the anchor entry (the trivial subset).
        candidates = [{ id, status: anchor[0]!.status }];
      }

      for (const c of candidates) {
        const entryId = String(c.id);
        const status = String(c.status);
        if (status === 'running') {
          skipped.push({ entry_id: entryId, reason: 'running' });
          continue;
        }
        if (status !== 'draft') {
          skipped.push({ entry_id: entryId, reason: 'already_submitted' });
          continue;
        }
        // Flip draft→submitted (status-only; the DB trigger does NOT fire on this).
        await tx.$executeRawUnsafe(
          `UPDATE time_entries SET status = 'submitted', updated_at = NOW()
           WHERE id = $1::bigint AND status = 'draft'`,
          entryId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO time_entry_state_history (time_entry_id, from_status, to_status, actor_id, reason)
           VALUES ($1::bigint, 'draft', 'submitted', $2::bigint, NULL)`,
          entryId,
          user.userId,
        );
        await this.audit.record({
          actorId: user.userId,
          action: 'time_entry.submit',
          entityType: 'time_entry',
          entityId: entryId,
          before: { status: 'draft' },
          after: { status: 'submitted' },
        });
        submittedIds.push(entryId);
      }

      // Upsert the period row to stamp submitted_at/submitted_by (owned by the submit path), then
      // recompute so the DERIVED status is authoritative. We insert a NEUTRAL 'open' placeholder
      // status here (not 'submitted') so recompute's reopened-detection — which only fires on a
      // locked→open drop — does NOT false-trigger on a fresh/partial submit; recompute then sets
      // the real rollup status (e.g. 'submitted', or 'rejected' if an existing rejected entry, or
      // 'open' for a still-partial week).
      await tx.$executeRawUnsafe(
        `INSERT INTO timesheet_periods
           (user_id, iso_year, iso_week, week_start_date, status, submitted_at, submitted_by, created_at, updated_at)
         VALUES (
           $1::bigint, $2::int, $3::int,
           (date_trunc('week', make_date($2::int, 1, 4)::timestamp)::date + (($3::int - 1) * 7)),
           'open', NOW(), $1::bigint, NOW(), NOW())
         ON CONFLICT (user_id, iso_year, iso_week) DO UPDATE SET
           submitted_at = COALESCE(timesheet_periods.submitted_at, NOW()),
           submitted_by = COALESCE(timesheet_periods.submitted_by, EXCLUDED.submitted_by),
           updated_at = NOW()`,
        user.userId,
        isoYear,
        isoWeek,
      );
      await this.periods.recomputePeriod(tx, user.userId, userTz, isoYear, isoWeek);
    });

    return { submitted_ids: submittedIds, skipped };
  }

  // Enqueues a real-time overtime check via pg-boss. Called from stop + switch
  // AFTER the transaction commits — we never enqueue for rolled-back work.
  // Best-effort: failures here log but do not break the user's stop/switch.
  private async enqueueOvertimeCheck(userId: string): Promise<void> {
    // The controller doesn't hold a pg-boss instance directly. The worker process
    // owns the boss; we surface this enqueue via a side-channel table that the
    // overtime-realtime job consumes. See packages/jobs/src/jobs/overtime-realtime.ts.
    // Using a queue table keeps apps/api free of pg-boss client deps.
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO overtime_realtime_queue (user_id, enqueued_at)
         VALUES ($1::bigint, NOW())
         ON CONFLICT (user_id) DO UPDATE SET enqueued_at = NOW()`,
        userId,
      );
    } catch {
      // Best-effort; the nightly batch will catch the overtime if this fails.
    }
  }

  @Post()
  async createManual(
    @CurrentUser() user: CurrentUserPayload,
    @Body(new ZodValidationPipe(ManualEntrySchema)) body: z.infer<typeof ManualEntrySchema>,
  ) {
    const startAt = new Date(body.start_at);
    const endAt = new Date(body.end_at);
    if (endAt <= startAt) throw new ValidationFailedError('end_at must be after start_at');
    const durationHours = (endAt.getTime() - startAt.getTime()) / 3.6e6;
    if (durationHours > 24) throw new ValidationFailedError('Manual entry cannot exceed 24 hours');
    // The DB GIST exclusion is the safety net; we also do an app-level pre-check.
    const overlap = await this.prisma.$queryRawUnsafe<Array<{ id: unknown }>>(
      `SELECT id FROM time_entries
       WHERE user_id = $1::bigint
         AND tstzrange(start_at, COALESCE(end_at, 'infinity'::timestamptz), '[)')
             && tstzrange($2::timestamptz, $3::timestamptz, '[)')
       LIMIT 1`,
      user.userId,
      startAt.toISOString(),
      endAt.toISOString(),
    );
    if (overlap.length > 0) throw new ValidationFailedError('Overlapping time entry exists');
    // FEAT-002 (issue #6, load-bearing): reject a create/back-date whose start_at lands in a
    // LOCKED period (PERIOD_LOCKED 409). App-level precheck; the DB trigger (HV001) is the backstop.
    const userTz = await this.periods.getUserTz(this.prisma, user.userId);
    await this.periods.assertPeriodWritable(this.prisma, user.userId, userTz, startAt);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `INSERT INTO time_entries (user_id, project_id, task_id, notes, start_at, end_at, status, billable)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::timestamptz, $6::timestamptz, 'draft', COALESCE($7, TRUE))
         RETURNING id, user_id, project_id, task_id, notes, start_at, end_at, status, billable`,
        user.userId,
        body.project_id,
        body.task_id ?? null,
        body.notes ?? null,
        startAt.toISOString(),
        endAt.toISOString(),
        body.billable ?? null,
      );
    } catch (err) {
      const mapped = mapPeriodLockDbError(err);
      if (mapped !== err) throw mapped;
      throw err;
    }
    return normalizeRow(rows[0]!, user.roles);
  }

  @Patch(':id')
  async edit(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() rawBody: unknown) {
    // Strict whitelist + type validation. Unknown keys are rejected (no IDOR via raw `Record<string, unknown>`).
    const body = PatchEntrySchema.parse(rawBody);

    const existing = await this.prisma.$queryRawUnsafe<
      Array<{ status: unknown; user_id: unknown; project_id: unknown; task_id: unknown; notes: unknown; start_at: unknown; end_at: unknown; billable: unknown }>
    >(
      `SELECT status, user_id, project_id, task_id, notes, start_at, end_at, billable
       FROM time_entries WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (existing.length === 0) throw new NotFoundError();
    if (String(existing[0]!.user_id) !== user.userId) {
      // Only self can edit. Admin unlock is a separate endpoint.
      throw new NotFoundError(); // uniform 404 to avoid leaking existence
    }
    const status = String(existing[0]!.status);
    if (LOCKED_STATUSES.has(status)) throw new EntryLockedError(id, status);

    // FEAT-002 (issue #6, load-bearing — the PATCH-move hole): if start_at (or end_at) changes,
    // reject when the NEW start_at lands in a LOCKED destination period (PERIOD_LOCKED 409).
    // The lock query is on the period table, so moving a draft within its own still-open week
    // passes. The own-status ENTRY_LOCKED check above fires first.
    if (body.start_at !== undefined || body.end_at !== undefined) {
      const newStartAt = body.start_at ?? (existing[0]!.start_at as string | Date);
      const userTz = await this.periods.getUserTz(this.prisma, user.userId);
      await this.periods.assertPeriodWritable(this.prisma, user.userId, userTz, newStartAt);
    }

    // Cross-project IDOR guard: when re-pointing to a different project, the new project
    // must be visible to the requester via RBAC.
    if (body.project_id !== undefined && body.project_id !== String(existing[0]!.project_id)) {
      await this.rbac.assertCanSeeProject(user.userId, body.project_id);
    }

    // Build the UPDATE from validated fields only.
    const fields: string[] = [];
    const params: unknown[] = [];
    const editableKeys = ['notes', 'start_at', 'end_at', 'project_id', 'task_id', 'billable'] as const;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of editableKeys) {
      if (body[key] !== undefined) {
        fields.push(`${key} = $${params.length + 1}`);
        params.push(body[key]);
        before[key] = existing[0]![key];
        after[key] = body[key];
      }
    }
    if (fields.length === 0) return { ok: true };
    params.push(id);
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE time_entries SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length}::bigint`,
        ...params,
      );
    } catch (err) {
      // FEAT-002: TOCTOU backstop — a concurrent submit locked the destination week between the
      // precheck and the UPDATE; the DB trigger (HV001) rejects. Map to a clean 409.
      const mapped = mapPeriodLockDbError(err);
      if (mapped !== err) throw mapped;
      throw err;
    }
    await this.audit.record({
      actorId: user.userId,
      action: 'time_entry.edit',
      entityType: 'time_entry',
      entityId: id,
      before,
      after,
    });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    const existing = await this.prisma.$queryRawUnsafe<Array<{ status: unknown; user_id: unknown; project_id: unknown; start_at: unknown; end_at: unknown }>>(
      `SELECT status, user_id, project_id, start_at, end_at FROM time_entries WHERE id = $1::bigint LIMIT 1`,
      id,
    );
    if (existing.length === 0) throw new NotFoundError();
    if (String(existing[0]!.user_id) !== user.userId) throw new NotFoundError();
    const status = String(existing[0]!.status);
    if (LOCKED_STATUSES.has(status)) throw new EntryLockedError(id, status);
    // FEAT-002 (issue #6, APPROVED hardening): block deleting an entry (e.g. a leftover draft)
    // whose start_at lands in a LOCKED period (PERIOD_LOCKED 409). The own-status ENTRY_LOCKED
    // check above fires first; this closes the "delete a draft out of a locked week" hole.
    const userTz = await this.periods.getUserTz(this.prisma, user.userId);
    await this.periods.assertPeriodWritable(this.prisma, user.userId, userTz, existing[0]!.start_at as string | Date);
    const before = {
      status,
      project_id: String(existing[0]!.project_id),
      start_at: existing[0]!.start_at,
      end_at: existing[0]!.end_at,
    };
    await this.prisma.$executeRawUnsafe(`DELETE FROM time_entries WHERE id = $1::bigint`, id);
    await this.audit.record({
      actorId: user.userId,
      action: 'time_entry.delete',
      entityType: 'time_entry',
      entityId: id,
      before,
    });
    return { ok: true };
  }
}

// Detects a Postgres unique-violation (SQLSTATE 23505) and, if a constraint
// name is supplied, narrows to that specific constraint. Used by the
// transactional start/switch race-conversion logic.
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { constraint?: string }; message?: string };
  const is23505 = e.code === '23505' || /23505|duplicate key/i.test(String(e.message ?? ''));
  if (!is23505) return false;
  if (!constraint) return true;
  const c = e.meta?.constraint ?? '';
  return c.includes(constraint) || String(e.message ?? '').includes(constraint);
}

// Strip cost-bearing fields entirely for non-financial roles per API_NOTES.md.
function normalizeRow(row: Record<string, unknown>, roles: string[]): Record<string, unknown> {
  const canSeeFinancial = roles.includes('admin') || roles.includes('finmgr');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!canSeeFinancial && (k === 'cost_rate' || k === 'cost_amount' || k === 'billable_rate' || k === 'billable_amount' || k === 'margin' || k === 'margin_pct')) {
      continue;
    }
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}
