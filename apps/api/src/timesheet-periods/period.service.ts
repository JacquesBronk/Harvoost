import { Injectable } from '@nestjs/common';
import { PeriodLockedError } from '@harvoost/shared';
import { PrismaService } from '../prisma/prisma.service';

// FEAT-002 (issue #6) — the timesheet_periods lock-oracle service.
//
// A `timesheet_periods` row is the lock oracle for (user, ISO-week). The period status is a
// DERIVED rollup of the user's entries whose start_at lands in that ISO-week (in the OWNER's
// IANA TZ), persisted for lockability + audit anchoring (DESIGN §1, §2). A period is LOCKED iff
// status ∈ {submitted, manager_approved, final_approved} — identical to LOCKED_STATUSES by design.
//
// ISO-week resolution uses the SAME SQL expression the DB lock trigger uses
// (EXTRACT(ISOYEAR/WEEK FROM (ts AT TIME ZONE tz))) so the app precheck and the DB backstop
// always agree on which week a timestamp belongs to (DESIGN §3, HANDOFF_db SQLSTATE HV001).

// The set of period statuses that block writes into the week (DESIGN §3).
export const LOCKED_PERIOD_STATUSES = new Set(['submitted', 'manager_approved', 'final_approved']);

const DEFAULT_TZ = 'Europe/Amsterdam';

export interface ResolvedWeek {
  isoYear: number;
  isoWeek: number;
  // Monday 00:00 of the ISO-week in the owner's TZ, as a YYYY-MM-DD DATE string.
  weekStartDate: string;
}

// A minimal Prisma-ish surface we accept for both the PrismaService and a $transaction tx client.
// Both expose $queryRawUnsafe/$executeRawUnsafe with the same shape.
export interface PrismaLike {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

@Injectable()
export class PeriodService {
  constructor(private readonly prisma: PrismaService) {}

  // Look up the owner's IANA TZ (fallback to the same default the DB trigger uses).
  async getUserTz(tx: PrismaLike, userId: string): Promise<string> {
    const rows = await tx.$queryRawUnsafe<Array<{ timezone: unknown }>>(
      `SELECT timezone FROM users WHERE id = $1::bigint LIMIT 1`,
      userId,
    );
    return rows.length > 0 && rows[0]!.timezone ? String(rows[0]!.timezone) : DEFAULT_TZ;
  }

  // resolveWeek — compute ISO year/week + the Monday DATE for `startAt` rendered in the owner's TZ.
  // Uses the trigger's exact SQL so app + DB agree on the bucket (DESIGN §3).
  async resolveWeek(tx: PrismaLike, userTz: string, startAt: Date | string): Promise<ResolvedWeek> {
    const iso = startAt instanceof Date ? startAt.toISOString() : startAt;
    const rows = await tx.$queryRawUnsafe<
      Array<{ iso_year: unknown; iso_week: unknown; week_start: unknown }>
    >(
      `SELECT
         EXTRACT(ISOYEAR FROM ($1::timestamptz AT TIME ZONE $2))::int AS iso_year,
         EXTRACT(WEEK    FROM ($1::timestamptz AT TIME ZONE $2))::int AS iso_week,
         (date_trunc('week', ($1::timestamptz AT TIME ZONE $2)))::date AS week_start`,
      iso,
      userTz,
    );
    const r = rows[0]!;
    return {
      isoYear: Number(r.iso_year),
      isoWeek: Number(r.iso_week),
      weekStartDate: weekStartToIso(r.week_start),
    };
  }

  // assertPeriodWritable — throw PeriodLockedError if startAt's resolved week has a LOCKED period.
  // No row / open / rejected ⇒ allowed (DESIGN §3). The single app-level enforcement point.
  async assertPeriodWritable(
    tx: PrismaLike,
    userId: string,
    userTz: string,
    startAt: Date | string,
  ): Promise<void> {
    const { isoYear, isoWeek } = await this.resolveWeek(tx, userTz, startAt);
    const rows = await tx.$queryRawUnsafe<Array<{ status: unknown }>>(
      `SELECT status FROM timesheet_periods
       WHERE user_id = $1::bigint AND iso_year = $2::int AND iso_week = $3::int
       LIMIT 1`,
      userId,
      isoYear,
      isoWeek,
    );
    if (rows.length === 0) return;
    const status = String(rows[0]!.status);
    if (LOCKED_PERIOD_STATUSES.has(status)) {
      throw new PeriodLockedError(isoYear, isoWeek, status);
    }
  }

  // recomputePeriod — recompute + upsert the period status from its entries (DESIGN §2 rollup).
  //
  //   entries := the user's non-'running' entries whose start_at ∈ the ISO-week (owner TZ)
  //   empty                          → leave at 'open' (never hard-delete the row; DESIGN §7.6)
  //   any 'rejected'                 → 'rejected'
  //   all 'final_approved'           → 'final_approved'
  //   all >= 'manager_approved'      → 'manager_approved'
  //   all >= 'submitted'             → 'submitted'
  //   else (>= 1 draft)              → 'open'
  //
  // Side effects on the period row: set/clear submitted_at is NOT touched here (submit owns it);
  // manager_approved_at/final_approved_at set when the period first reaches that state; reopened_at
  // set when the period drops back to 'open' from a locked state (the D4 reopen mechanism).
  async recomputePeriod(
    tx: PrismaLike,
    userId: string,
    userTz: string,
    isoYear: number,
    isoWeek: number,
  ): Promise<void> {
    // Aggregate the week's non-running entries, bucketed by start_at in the owner's TZ.
    const counts = await tx.$queryRawUnsafe<
      Array<{ status: unknown; n: unknown }>
    >(
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

    const by: Record<string, number> = {};
    let total = 0;
    for (const c of counts) {
      const n = Number(c.n);
      by[String(c.status)] = n;
      total += n;
    }

    // Does a period row already exist? (We only upsert when there's something to record.)
    const existing = await tx.$queryRawUnsafe<Array<{ status: unknown }>>(
      `SELECT status FROM timesheet_periods
       WHERE user_id = $1::bigint AND iso_year = $2::int AND iso_week = $3::int
       LIMIT 1`,
      userId,
      isoYear,
      isoWeek,
    );
    const prevStatus = existing.length > 0 ? String(existing[0]!.status) : null;

    const newStatus = rollup(by, total);

    // Empty week with no existing row ⇒ nothing to persist (an open week has no row, DESIGN §1).
    // We never CREATE a row for an empty/open week here; submit owns first-row creation.
    if (total === 0 && prevStatus === null) return;
    if (prevStatus === null && newStatus === 'open') return;

    // Compute timestamp transitions relative to the previous status.
    const wasLocked = prevStatus !== null && LOCKED_PERIOD_STATUSES.has(prevStatus);
    const reopened = wasLocked && newStatus === 'open'; // dropped out of a locked status → reopen (D4).

    if (prevStatus === null) {
      // First persisted row for this week (rare via recompute — usually submit creates it).
      // week_start_date is derived from (iso_year, iso_week): the Monday of the ISO-week.
      // ISO week 1 is the week containing Jan 4; Monday-of(Jan 4) + (iso_week-1) weeks.
      await tx.$executeRawUnsafe(
        `INSERT INTO timesheet_periods
           (user_id, iso_year, iso_week, week_start_date, status,
            manager_approved_at, final_approved_at, reopened_at, created_at, updated_at)
         VALUES (
           $1::bigint, $2::int, $3::int,
           (date_trunc('week', make_date($2::int, 1, 4)::timestamp)::date
              + (($3::int - 1) * 7)),
           $4,
           CASE WHEN $4 IN ('manager_approved','final_approved') THEN NOW() ELSE NULL END,
           CASE WHEN $4 = 'final_approved' THEN NOW() ELSE NULL END,
           NULL, NOW(), NOW())
         ON CONFLICT (user_id, iso_year, iso_week) DO UPDATE SET
           status = EXCLUDED.status, updated_at = NOW()`,
        userId,
        isoYear,
        isoWeek,
        newStatus,
      );
      return;
    }

    // UPDATE the existing row's status + the appropriate timestamps.
    await tx.$executeRawUnsafe(
      `UPDATE timesheet_periods SET
         status = $4,
         manager_approved_at = CASE
           WHEN $4 IN ('manager_approved','final_approved') AND manager_approved_at IS NULL THEN NOW()
           WHEN $4 NOT IN ('manager_approved','final_approved') THEN NULL
           ELSE manager_approved_at END,
         final_approved_at = CASE
           WHEN $4 = 'final_approved' AND final_approved_at IS NULL THEN NOW()
           WHEN $4 <> 'final_approved' THEN NULL
           ELSE final_approved_at END,
         reopened_at = CASE WHEN $5::boolean THEN NOW() ELSE reopened_at END,
         updated_at = NOW()
       WHERE user_id = $1::bigint AND iso_year = $2::int AND iso_week = $3::int`,
      userId,
      isoYear,
      isoWeek,
      newStatus,
      reopened,
    );
  }
}

// mapPeriodLockDbError — translate the DB lock trigger's SQLSTATE HV001 (the TOCTOU backstop,
// HANDOFF_db) into a clean PeriodLockedError (409). Mirrors how the GiST overlap 23P01 is mapped
// to a domain error today (billable-rates.controller.ts:165). The trigger's message embeds the
// iso_year/iso_week/status (e.g. "Cannot write into week 2026-W21 — it is submitted and locked
// (PERIOD_LOCKED).") and a DETAIL line "iso_year=2026 iso_week=21 status=submitted"; we parse
// those so the envelope details match the app-level precheck. Returns the original error untouched
// if it is not an HV001 lock rejection.
export function mapPeriodLockDbError(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return err;
  const e = err as { code?: string; message?: string; meta?: { code?: string }; detail?: string };
  const code = e.code ?? e.meta?.code;
  const message = String(e.message ?? '');
  const isHv001 = code === 'HV001' || /HV001|PERIOD_LOCKED/.test(message);
  if (!isHv001) return err;

  // Try to recover iso_year / iso_week / status from the DETAIL line or the message body.
  const haystack = `${message} ${String(e.detail ?? '')}`;
  const yearM = /iso_year[=\s]+(\d{4})/.exec(haystack) ?? /(\d{4})-W\d{2}/.exec(haystack);
  const weekM = /iso_week[=\s]+(\d{1,2})/.exec(haystack) ?? /\d{4}-W(\d{2})/.exec(haystack);
  const statusM = /status[=\s]+([a-z_]+)/.exec(haystack) ?? /it is ([a-z_]+) and locked/.exec(haystack);
  const isoYear = yearM ? Number(yearM[1]) : 0;
  const isoWeek = weekM ? Number(weekM[1]) : 0;
  const status = statusM ? statusM[1]! : 'submitted';
  return new PeriodLockedError(isoYear, isoWeek, status);
}

// rollup — the DESIGN §2 derived-status function over a status→count map.
function rollup(by: Record<string, number>, total: number): string {
  if (total === 0) return 'open';
  if ((by['rejected'] ?? 0) > 0) return 'rejected';
  const draft = by['draft'] ?? 0;
  const submitted = by['submitted'] ?? 0;
  const managerApproved = by['manager_approved'] ?? 0;
  const finalApproved = by['final_approved'] ?? 0;
  if (draft > 0) return 'open'; // partial week — not fully submitted
  if (finalApproved === total) return 'final_approved';
  if (managerApproved + finalApproved === total) return 'manager_approved';
  if (submitted + managerApproved + finalApproved === total) return 'submitted';
  return 'open';
}

// Normalize a DATE value (Prisma returns a Date or a string depending on driver) to YYYY-MM-DD.
function weekStartToIso(v: unknown): string {
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  return s.slice(0, 10);
}
