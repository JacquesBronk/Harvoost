-- =============================================================================
-- timesheet_periods migration — FEAT-002 (GitHub #6) Option F
-- =============================================================================
-- Adds the period entity that owns the open/locked lifecycle for a
-- (user, ISO-week), plus a DB-level lock trigger on time_entries that rejects
-- a write whose start_at lands in a LOCKED period.
--
-- ADDITIVE / non-destructive:
--   * CREATE TABLE IF NOT EXISTS (brand-new table, no backfill).
--   * No ALTER on time_entries (only a BEFORE-trigger is attached).
--   * Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE.
--   * Re-applying is a no-op.
--
-- The period status is a DERIVED rollup persisted for lockability + audit
-- anchoring (see FEAT-002/DESIGN.md §1, §2). A row exists iff the week has been
-- submitted at least once; an open week with only draft entries has NO row
-- (= implicitly 'open' = never locked).
-- =============================================================================

-- --- timesheet_periods -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "timesheet_periods" (
  "id"                   BIGSERIAL PRIMARY KEY,
  "user_id"              BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "iso_year"             INT NOT NULL,
  "iso_week"             INT NOT NULL CHECK ("iso_week" BETWEEN 1 AND 53),
  -- Monday 00:00 in the user's TZ, stored as a DATE: the deterministic,
  -- TZ-resolved anchor. Half-open week is [week_start, week_start+7d) in the
  -- user's TZ.
  "week_start_date"      DATE NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'open'
                         CHECK ("status" IN ('open', 'submitted', 'manager_approved', 'final_approved', 'rejected')),
  "submitted_at"         TIMESTAMPTZ(6),
  "submitted_by"         BIGINT REFERENCES "users" ("id") ON DELETE SET NULL,
  "manager_approved_at"  TIMESTAMPTZ(6),
  "final_approved_at"    TIMESTAMPTZ(6),
  "reopened_at"          TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- One row per (user, ISO-week). Also serves the lock lookup
  -- WHERE user_id=? AND iso_year=? AND iso_week=?.
  CONSTRAINT "tp_user_week_unique" UNIQUE ("user_id", "iso_year", "iso_week")
);

-- Approval-queue period rollups by status.
CREATE INDEX IF NOT EXISTS "tp_status_idx"
  ON "timesheet_periods" ("status");
-- "my open/submitted weeks".
CREATE INDEX IF NOT EXISTS "tp_user_status_idx"
  ON "timesheet_periods" ("user_id", "status");

-- =============================================================================
-- DB-level lock trigger on time_entries (FEAT-002 DESIGN §3 — TOCTOU hardening)
-- =============================================================================
-- A write is rejected with SQLSTATE 'HV001' (custom user-defined class 'HV',
-- which does not collide with the GiST overlap '23P01', unique '23505', or any
-- built-in Postgres error class) iff the candidate entry's start_at, rendered
-- in the OWNER's IANA TZ, falls in an ISO-week whose timesheet_periods row
-- exists AND has status IN ('submitted','manager_approved','final_approved').
--
-- FIRING RULE (load-bearing): enforce ONLY on a CREATE or a DATE-MOVE — i.e.
--   TG_OP = 'INSERT'
--   OR (TG_OP = 'UPDATE' AND NEW.start_at IS DISTINCT FROM OLD.start_at).
-- A status-only UPDATE (start_at unchanged) MUST be a no-op, because submit
-- flips draft→submitted and approvals flip status — none change start_at; if the
-- trigger fired on those it would block the very submit/approval that sets the
-- lock. So status transitions pass through untouched; only new entries and
-- back-date / move-into-a-locked-week are blocked.
-- =============================================================================
CREATE OR REPLACE FUNCTION timesheet_period_lock_check()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_tz          TEXT;
  v_iso_year    INT;
  v_iso_week    INT;
  v_status      TEXT;
BEGIN
  -- No-op on status-only updates (start_at unchanged). Only CREATE or DATE-MOVE
  -- are enforced.
  IF TG_OP = 'UPDATE' AND NEW.start_at IS NOT DISTINCT FROM OLD.start_at THEN
    RETURN NEW;
  END IF;

  -- Defensive: a NULL start_at is never bucketable. time_entries.start_at is
  -- NOT NULL in the schema, so this is belt-and-suspenders only.
  IF NEW.start_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Resolve the owner's IANA TZ (fall back to Europe/Amsterdam to mirror the
  -- User.timezone column default; this branch is unreachable for FK-valid rows
  -- since users.timezone is NOT NULL with a default).
  SELECT u.timezone INTO v_tz
    FROM users u
   WHERE u.id = NEW.user_id;
  IF v_tz IS NULL THEN
    v_tz := 'Europe/Amsterdam';
  END IF;

  -- ISO-year/week of the candidate timestamp in the OWNER's TZ.
  -- NEW.start_at is timestamptz; AT TIME ZONE <iana> renders that wall-clock.
  v_iso_year := EXTRACT(ISOYEAR FROM (NEW.start_at AT TIME ZONE v_tz))::int;
  v_iso_week := EXTRACT(WEEK    FROM (NEW.start_at AT TIME ZONE v_tz))::int;

  -- Look up the period for that (user, ISO-week). Uses tp_user_week_unique.
  SELECT tp.status INTO v_status
    FROM timesheet_periods tp
   WHERE tp.user_id  = NEW.user_id
     AND tp.iso_year = v_iso_year
     AND tp.iso_week = v_iso_week;

  -- Reject only when a row exists AND it is in a locked status. No row, or
  -- 'open'/'rejected', passes through.
  IF v_status IS NOT NULL
     AND v_status IN ('submitted', 'manager_approved', 'final_approved') THEN
    RAISE EXCEPTION
      'Cannot write into week %-W% — it is % and locked (PERIOD_LOCKED).',
      v_iso_year, lpad(v_iso_week::text, 2, '0'), v_status
      USING ERRCODE = 'HV001',
            DETAIL  = format('iso_year=%s iso_week=%s status=%s', v_iso_year, v_iso_week, v_status);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "timesheet_period_lock_trg" ON "time_entries";
CREATE TRIGGER "timesheet_period_lock_trg"
  BEFORE INSERT OR UPDATE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION timesheet_period_lock_check();

-- =============================================================================
-- DOWN (manual reversal — Prisma migrate does not auto-run a down):
--   DROP TRIGGER IF EXISTS "timesheet_period_lock_trg" ON "time_entries";
--   DROP FUNCTION IF EXISTS timesheet_period_lock_check();
--   DROP TABLE IF EXISTS "timesheet_periods";
-- Fully reversible: the table is brand-new with no backfill, and the trigger
-- only rejects writes (never mutates/deletes data), so dropping it loses
-- nothing but the lock enforcement.
-- =============================================================================
