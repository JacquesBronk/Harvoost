-- =============================================================================
-- feature_completion migration — 2026-05-23 backend-dev final pass
-- =============================================================================
-- Adds the support tables for: (a) real-time overtime queue side-channel,
-- (b) async XLSX export jobs, (c) email retry tracking columns. Greenfield-
-- safe — all tables/columns use IF NOT EXISTS so re-applying is a no-op.
-- =============================================================================

-- (a) overtime_realtime_queue: written by time-entries controller on stop/switch,
--     drained by packages/jobs/src/jobs/overtime-realtime.ts every minute.
--     UNIQUE (user_id) so concurrent enqueues collapse — the worker fans the
--     real-time check across both OT_DAY and OT_WEEK for the user's current
--     local-TZ day.
CREATE TABLE IF NOT EXISTS "overtime_realtime_queue" (
  "user_id"     BIGINT PRIMARY KEY REFERENCES "users" ("id") ON DELETE CASCADE,
  "enqueued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ortq_enqueued_idx"
  ON "overtime_realtime_queue" ("enqueued_at");

-- (b) export_jobs: async XLSX export tracking. Status state machine is
--     queued → running → (done|failed). SAS URL + expiry live on the row
--     so the polling endpoint is a single SELECT.
CREATE TABLE IF NOT EXISTS "export_jobs" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_user_id"  BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "status"         TEXT NOT NULL DEFAULT 'queued'
                   CHECK ("status" IN ('queued','running','done','failed')),
  "filter"         JSONB NOT NULL,
  "download_url"   TEXT,
  "expires_at"     TIMESTAMPTZ(6),
  "error"          TEXT,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "export_jobs_actor_created_idx"
  ON "export_jobs" ("actor_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "export_jobs_status_created_idx"
  ON "export_jobs" ("status", "created_at");

-- (c) email_delivery_log: widen with retry tracking. Existing rows default to
--     retry_count=0, next_retry_at=NULL — the retry job uses these to gate.
--     We also accept a new status value 'failed_permanent' (added via CHECK
--     constraint replacement).
ALTER TABLE "email_delivery_log"
  ADD COLUMN IF NOT EXISTS "retry_count" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMPTZ(6);

-- Replace status check to include 'failed_permanent'. The original check is
-- unnamed in the init migration; we recreate it under a stable name so future
-- migrations can drop it explicitly.
DO $$
BEGIN
  -- Drop any pre-existing CHECK on status (the init migration declared an
  -- inline CHECK which Postgres names automatically). The safest way is to
  -- iterate and drop check constraints whose definition references status.
  PERFORM 1 FROM pg_constraint
   WHERE conrelid = 'email_delivery_log'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%';
  IF FOUND THEN
    EXECUTE (
      SELECT 'ALTER TABLE email_delivery_log DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'email_delivery_log'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE "email_delivery_log"
  ADD CONSTRAINT "edl_status_check"
  CHECK ("status" IN ('queued', 'sent', 'failed', 'failed_permanent', 'suppressed'));
