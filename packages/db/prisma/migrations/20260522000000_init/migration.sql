-- Harvoost initial schema.
-- Greenfield. Creates all 28 tables, extensions, generated columns,
-- EXCLUDE constraints, partial unique indexes, the audit hash-chain
-- trigger, and the rate-lookup helper functions.
--
-- DOWN (manual, dev only):
--   DROP SCHEMA public CASCADE; CREATE SCHEMA public;
-- (no automatic rollback — this is the first migration and Postgres has no
-- transactional DDL for CREATE EXTENSION across all extensions in one txn).

-- =============================================================================
-- Extensions
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "btree_gist";  -- gist index over scalar + range (EXCLUDE on time_entries)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";      -- case-insensitive email lookups

-- =============================================================================
-- Tables
-- =============================================================================

-- --- users ------------------------------------------------------------------
CREATE TABLE "users" (
  "id"                     BIGSERIAL PRIMARY KEY,
  "entra_object_id"        TEXT NOT NULL UNIQUE,
  "email"                  CITEXT NOT NULL UNIQUE,
  "display_name"           TEXT NOT NULL,
  "timezone"               TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  "weekly_summary_opt_out" BOOLEAN NOT NULL DEFAULT FALSE,
  "is_active"              BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "users_is_active_idx" ON "users" ("is_active");

-- --- user_roles -------------------------------------------------------------
CREATE TABLE "user_roles" (
  "id"          BIGSERIAL PRIMARY KEY,
  "user_id"     BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "role"        TEXT NOT NULL CHECK ("role" IN ('admin', 'finmgr', 'manager', 'employee')),
  "assigned_by" BIGINT REFERENCES "users" ("id") ON DELETE SET NULL,
  "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_roles_user_role_unique" UNIQUE ("user_id", "role")
);
CREATE INDEX "user_roles_user_id_idx" ON "user_roles" ("user_id");

-- --- user_managers ----------------------------------------------------------
CREATE TABLE "user_managers" (
  "id"         BIGSERIAL PRIMARY KEY,
  "user_id"    BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "manager_id" BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_managers_user_manager_unique" UNIQUE ("user_id", "manager_id"),
  CONSTRAINT "user_managers_no_self_reports" CHECK ("user_id" <> "manager_id")
);
CREATE INDEX "user_managers_manager_id_idx" ON "user_managers" ("manager_id");
CREATE INDEX "user_managers_user_id_idx"    ON "user_managers" ("user_id");

-- --- clients ----------------------------------------------------------------
CREATE TABLE "clients" (
  "id"         BIGSERIAL PRIMARY KEY,
  "name"       TEXT NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "clients_name_idx" ON "clients" ("name");

-- --- projects ---------------------------------------------------------------
CREATE TABLE "projects" (
  "id"               BIGSERIAL PRIMARY KEY,
  "client_id"        BIGINT NOT NULL REFERENCES "clients" ("id") ON DELETE RESTRICT,
  "code"             TEXT UNIQUE,
  "name"             TEXT NOT NULL,
  "billing_mode"     TEXT NOT NULL CHECK ("billing_mode" IN ('hourly', 'fixed_fee', 'non_billable')),
  "fixed_fee_amount" NUMERIC(14, 2),
  "currency"         CHAR(3) NOT NULL,
  "hours_budget"     NUMERIC(8, 2),
  "is_active"        BOOLEAN NOT NULL DEFAULT TRUE,
  "department"       TEXT,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "projects_client_id_idx" ON "projects" ("client_id");
CREATE INDEX "projects_is_active_idx" ON "projects" ("is_active");

-- --- project_billing_mode_history -------------------------------------------
CREATE TABLE "project_billing_mode_history" (
  "id"             BIGSERIAL PRIMARY KEY,
  "project_id"     BIGINT NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "billing_mode"   TEXT NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to"   DATE,
  -- Prevent overlapping ranges per project. daterange '[)' inclusive-exclusive.
  CONSTRAINT "pbm_history_no_overlap" EXCLUDE USING gist (
    "project_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", DATE '9999-12-31'), '[)') WITH &&
  )
);
CREATE INDEX "pbm_history_project_effective_idx" ON "project_billing_mode_history" ("project_id", "effective_from");

-- --- project_members --------------------------------------------------------
CREATE TABLE "project_members" (
  "id"         BIGSERIAL PRIMARY KEY,
  "project_id" BIGINT NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "user_id"    BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "joined_at"  DATE NOT NULL DEFAULT CURRENT_DATE,
  "left_at"    DATE
);
-- A user can only have ONE active membership per project at a time.
CREATE UNIQUE INDEX "project_members_active_unique"
  ON "project_members" ("project_id", "user_id")
  WHERE "left_at" IS NULL;
CREATE INDEX "project_members_user_left_idx"    ON "project_members" ("user_id", "left_at");
CREATE INDEX "project_members_project_left_idx" ON "project_members" ("project_id", "left_at");

-- --- project_managers -------------------------------------------------------
CREATE TABLE "project_managers" (
  "id"          BIGSERIAL PRIMARY KEY,
  "project_id"  BIGINT NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "manager_id"  BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "project_managers_project_manager_unique" UNIQUE ("project_id", "manager_id")
);
CREATE INDEX "project_managers_manager_id_idx" ON "project_managers" ("manager_id");
CREATE INDEX "project_managers_project_id_idx" ON "project_managers" ("project_id");

-- --- project_tasks ----------------------------------------------------------
CREATE TABLE "project_tasks" (
  "id"          BIGSERIAL PRIMARY KEY,
  "project_id"  BIGINT NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "name"        TEXT NOT NULL,
  "is_billable" BOOLEAN NOT NULL DEFAULT TRUE,
  "is_active"   BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "project_tasks_active_name_unique"
  ON "project_tasks" ("project_id", "name")
  WHERE "is_active" = TRUE;
CREATE INDEX "project_tasks_project_id_idx" ON "project_tasks" ("project_id");

-- --- project_billable_rates -------------------------------------------------
CREATE TABLE "project_billable_rates" (
  "id"             BIGSERIAL PRIMARY KEY,
  "project_id"     BIGINT NOT NULL REFERENCES "projects" ("id") ON DELETE CASCADE,
  "task_id"        BIGINT REFERENCES "project_tasks" ("id") ON DELETE CASCADE,
  "rate"           NUMERIC(10, 2) NOT NULL,
  "currency"       CHAR(3) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to"   DATE,
  "created_by"     BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "pbr_no_overlap" EXCLUDE USING gist (
    "project_id" WITH =,
    COALESCE("task_id", 0) WITH =,
    daterange("effective_from", COALESCE("effective_to", DATE '9999-12-31'), '[)') WITH &&
  )
);
CREATE INDEX "pbr_project_task_effective_idx" ON "project_billable_rates" ("project_id", "task_id", "effective_from");

-- --- employee_cost_rates ----------------------------------------------------
CREATE TABLE "employee_cost_rates" (
  "id"             BIGSERIAL PRIMARY KEY,
  "user_id"        BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "rate"           NUMERIC(10, 2) NOT NULL,
  "currency"       CHAR(3) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to"   DATE,
  "created_by"     BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ecr_no_overlap" EXCLUDE USING gist (
    "user_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", DATE '9999-12-31'), '[)') WITH &&
  )
);
CREATE INDEX "ecr_user_effective_idx" ON "employee_cost_rates" ("user_id", "effective_from");

-- --- time_entries -----------------------------------------------------------
CREATE TABLE "time_entries" (
  "id"              BIGSERIAL PRIMARY KEY,
  "user_id"         BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "project_id"     BIGINT NOT NULL REFERENCES "projects" ("id") ON DELETE RESTRICT,
  "task_id"         BIGINT REFERENCES "project_tasks" ("id") ON DELETE SET NULL,
  "notes"           TEXT,
  "start_at"        TIMESTAMPTZ(6) NOT NULL,
  "end_at"          TIMESTAMPTZ(6),
  "time_range"      TSTZRANGE GENERATED ALWAYS AS (tstzrange("start_at", "end_at", '[)')) STORED,
  "status"          TEXT NOT NULL CHECK ("status" IN ('running', 'draft', 'submitted', 'manager_approved', 'final_approved', 'rejected')),
  "billable"        BOOLEAN NOT NULL DEFAULT TRUE,
  "mood_score"      SMALLINT CHECK ("mood_score" IS NULL OR "mood_score" BETWEEN 1 AND 5),
  "idempotency_key" TEXT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  -- Running entries have NULL end_at. Only closed entries participate in
  -- overlap detection — a user IS allowed to have a single running entry
  -- alongside their historical closed ones.
  CONSTRAINT "te_no_overlap" EXCLUDE USING gist (
    "user_id" WITH =,
    "time_range" WITH &&
  ) WHERE ("end_at" IS NOT NULL),
  -- A running entry must have end_at NULL; a closed entry must have end_at.
  CONSTRAINT "te_end_at_matches_status" CHECK (
    ("status" = 'running' AND "end_at" IS NULL)
    OR ("status" <> 'running' AND "end_at" IS NOT NULL)
  )
);
-- At most one running entry per user.
CREATE UNIQUE INDEX "te_one_running_per_user"
  ON "time_entries" ("user_id")
  WHERE "status" = 'running';
-- Idempotency-key dedupe (only when key is supplied).
CREATE UNIQUE INDEX "te_idempotency_unique"
  ON "time_entries" ("user_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "te_user_start_idx"           ON "time_entries" ("user_id", "start_at" DESC);
CREATE INDEX "te_project_start_idx"        ON "time_entries" ("project_id", "start_at" DESC);
CREATE INDEX "te_status_idx"               ON "time_entries" ("status");
CREATE INDEX "te_status_start_idx"         ON "time_entries" ("status", "start_at");
CREATE INDEX "te_start_idx"                ON "time_entries" ("start_at");
CREATE INDEX "te_user_status_start_idx"    ON "time_entries" ("user_id", "status", "start_at");

-- --- time_entry_state_history -----------------------------------------------
CREATE TABLE "time_entry_state_history" (
  "id"            BIGSERIAL PRIMARY KEY,
  "time_entry_id" BIGINT NOT NULL REFERENCES "time_entries" ("id") ON DELETE CASCADE,
  "from_status"   TEXT,
  "to_status"     TEXT NOT NULL,
  "actor_id"      BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "reason"        TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "tesh_entry_created_idx" ON "time_entry_state_history" ("time_entry_id", "created_at");
CREATE INDEX "tesh_actor_created_idx" ON "time_entry_state_history" ("actor_id", "created_at");

-- --- mood_entries -----------------------------------------------------------
CREATE TABLE "mood_entries" (
  "id"         BIGSERIAL PRIMARY KEY,
  "user_id"    BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "local_date" DATE NOT NULL,
  "score"      SMALLINT NOT NULL CHECK ("score" BETWEEN 1 AND 5),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "mood_entries_user_localdate_unique" UNIQUE ("user_id", "local_date")
);
CREATE INDEX "mood_entries_user_date_idx"   ON "mood_entries" ("user_id", "local_date" DESC);
CREATE INDEX "mood_entries_created_at_idx"  ON "mood_entries" ("created_at"); -- retention scan

-- --- mood_weekly_aggregates -------------------------------------------------
CREATE TABLE "mood_weekly_aggregates" (
  "id"           BIGSERIAL PRIMARY KEY,
  "team_anchor"  TEXT NOT NULL,
  "iso_year"     INT NOT NULL,
  "iso_week"     INT NOT NULL CHECK ("iso_week" BETWEEN 1 AND 53),
  "sample_size"  INT NOT NULL CHECK ("sample_size" >= 5),
  "score_avg"    NUMERIC(3, 2) NOT NULL,
  "score_stdev"  NUMERIC(3, 2),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "mwa_anchor_year_week_unique" UNIQUE ("team_anchor", "iso_year", "iso_week")
);

-- --- schedule_templates -----------------------------------------------------
CREATE TABLE "schedule_templates" (
  "id"               BIGSERIAL PRIMARY KEY,
  "user_id"          BIGINT NOT NULL UNIQUE REFERENCES "users" ("id") ON DELETE CASCADE,
  "working_days"     SMALLINT[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5]::SMALLINT[],
  "start_time"       TIME(0) NOT NULL DEFAULT '08:00',
  "end_time"         TIME(0) NOT NULL DEFAULT '17:00',
  "lunch_start_time" TIME(0) DEFAULT '12:00',
  "lunch_end_time"   TIME(0) DEFAULT '13:00',
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- --- schedule_overrides -----------------------------------------------------
CREATE TABLE "schedule_overrides" (
  "id"               BIGSERIAL PRIMARY KEY,
  "scope"            TEXT NOT NULL CHECK ("scope" IN ('user', 'project', 'org')),
  "user_id"          BIGINT REFERENCES "users" ("id") ON DELETE CASCADE,
  "project_id"       BIGINT REFERENCES "projects" ("id") ON DELETE CASCADE,
  "effective_from"   DATE NOT NULL,
  "effective_to"     DATE NOT NULL,
  "start_time"       TIME(0),
  "end_time"         TIME(0),
  "lunch_start_time" TIME(0),
  "lunch_end_time"   TIME(0),
  "reason"           TEXT,
  "created_by"       BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "so_scope_target_consistent" CHECK (
    ("scope" = 'user'    AND "user_id" IS NOT NULL AND "project_id" IS NULL)
    OR ("scope" = 'project' AND "project_id" IS NOT NULL AND "user_id" IS NULL)
    OR ("scope" = 'org'     AND "user_id" IS NULL AND "project_id" IS NULL)
  ),
  CONSTRAINT "so_range_valid" CHECK ("effective_to" >= "effective_from"),
  -- Prevent overlapping windows within the same scope+target.
  CONSTRAINT "so_no_overlap" EXCLUDE USING gist (
    "scope" WITH =,
    COALESCE("user_id", 0) WITH =,
    COALESCE("project_id", 0) WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  )
);
CREATE INDEX "so_user_effective_idx"    ON "schedule_overrides" ("scope", "user_id", "effective_from");
CREATE INDEX "so_project_effective_idx" ON "schedule_overrides" ("scope", "project_id", "effective_from");

-- --- leave_requests ---------------------------------------------------------
CREATE TABLE "leave_requests" (
  "id"                  BIGSERIAL PRIMARY KEY,
  "user_id"             BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "leave_type"          TEXT NOT NULL CHECK ("leave_type" IN ('annual', 'sick', 'unpaid', 'other')),
  "start_date"          DATE NOT NULL,
  "end_date"            DATE NOT NULL,
  "half_day"            TEXT CHECK ("half_day" IN ('am', 'pm') OR "half_day" IS NULL),
  "note"                TEXT,
  "status"              TEXT NOT NULL CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
  "approved_by"         BIGINT REFERENCES "users" ("id") ON DELETE SET NULL,
  "approved_at"         TIMESTAMPTZ(6),
  "rejection_reason"    TEXT,
  "bamboo_request_id"   TEXT,
  "bamboo_sync_status"  TEXT NOT NULL DEFAULT 'not_applicable' CHECK ("bamboo_sync_status" IN ('pending', 'synced', 'failed', 'not_applicable')),
  "bamboo_synced_at"    TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "leave_range_valid" CHECK ("end_date" >= "start_date")
);
CREATE INDEX "leave_user_start_idx"   ON "leave_requests" ("user_id", "start_date");
CREATE INDEX "leave_status_start_idx" ON "leave_requests" ("status", "start_date");

-- --- exceptions -------------------------------------------------------------
CREATE TABLE "exceptions" (
  "id"              BIGSERIAL PRIMARY KEY,
  "user_id"         BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "exception_type"  TEXT NOT NULL CHECK ("exception_type" IN ('MISSED_PUNCH', 'OVERTIME_DAY', 'OVERTIME_WEEK', 'ANOMALY_LOW', 'ANOMALY_HIGH')),
  "local_date"      DATE NOT NULL,
  "details"         JSONB NOT NULL,
  "status"          TEXT NOT NULL CHECK ("status" IN ('open', 'resolved', 'dismissed')),
  "resolved_at"     TIMESTAMPTZ(6),
  "resolved_by"     BIGINT REFERENCES "users" ("id") ON DELETE SET NULL,
  "resolution_note" TEXT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "exceptions_unique_per_day" UNIQUE ("user_id", "exception_type", "local_date")
);
CREATE INDEX "exceptions_user_status_date_idx" ON "exceptions" ("user_id", "status", "local_date");
CREATE INDEX "exceptions_status_date_idx"      ON "exceptions" ("status", "local_date");

-- --- audit_log --------------------------------------------------------------
CREATE TABLE "audit_log" (
  "id"            BIGSERIAL PRIMARY KEY,
  "actor_id"      BIGINT REFERENCES "users" ("id") ON DELETE SET NULL,
  "action"        TEXT NOT NULL,
  "entity_type"   TEXT,
  "entity_id"     TEXT,
  "before"        JSONB,
  "after"         JSONB,
  "reason"        TEXT,
  "prev_row_hash" CHAR(64),
  "row_hash"      CHAR(64) NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "audit_actor_created_idx"        ON "audit_log" ("actor_id", "created_at");
CREATE INDEX "audit_entity_created_idx"       ON "audit_log" ("entity_type", "entity_id", "created_at");
CREATE INDEX "audit_action_created_idx"       ON "audit_log" ("action", "created_at");

-- --- email_delivery_log -----------------------------------------------------
CREATE TABLE "email_delivery_log" (
  "id"                   BIGSERIAL PRIMARY KEY,
  "user_id"              BIGINT REFERENCES "users" ("id") ON DELETE SET NULL,
  "kind"                 TEXT NOT NULL,
  "summary_period_start" DATE,
  "summary_period_end"   DATE,
  "status"               TEXT NOT NULL CHECK ("status" IN ('queued', 'sent', 'failed', 'suppressed')),
  "mode"                 TEXT CHECK ("mode" IN ('llm', 'template') OR "mode" IS NULL),
  "message_id"           TEXT,
  "error_detail"         TEXT,
  "sent_at"              TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "edl_user_created_idx"   ON "email_delivery_log" ("user_id", "created_at");
CREATE INDEX "edl_status_created_idx" ON "email_delivery_log" ("status", "created_at");

-- --- chatbot_tool_invocations -----------------------------------------------
CREATE TABLE "chatbot_tool_invocations" (
  "id"                BIGSERIAL PRIMARY KEY,
  "user_id"           BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "prompt"            TEXT NOT NULL,
  "tool_name"         TEXT NOT NULL,
  "tool_params"       JSONB NOT NULL,
  "result_row_count"  INT,
  "result_truncated"  BOOLEAN NOT NULL DEFAULT FALSE,
  "tokens_in"         INT,
  "tokens_out"        INT,
  "latency_ms"        INT,
  "status"            TEXT NOT NULL CHECK ("status" IN ('ok', 'tool_error', 'llm_error', 'rate_limited', 'out_of_scope')),
  "error_detail"      TEXT,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "cti_user_created_idx"   ON "chatbot_tool_invocations" ("user_id", "created_at");
CREATE INDEX "cti_status_created_idx" ON "chatbot_tool_invocations" ("status", "created_at");

-- --- chatbot_conversations --------------------------------------------------
CREATE TABLE "chatbot_conversations" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "started_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "metadata"        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX "cc_user_last_message_idx" ON "chatbot_conversations" ("user_id", "last_message_at" DESC);
CREATE INDEX "cc_last_message_idx"      ON "chatbot_conversations" ("last_message_at");

-- --- chatbot_messages -------------------------------------------------------
CREATE TABLE "chatbot_messages" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL REFERENCES "chatbot_conversations" ("id") ON DELETE CASCADE,
  "role"            TEXT NOT NULL CHECK ("role" IN ('user', 'assistant', 'tool')),
  "content"         TEXT,
  "tool_name"       TEXT,
  "tool_call_id"    TEXT,
  "tool_input"      JSONB,
  "tool_output"     JSONB,
  "tokens_in"       INT,
  "tokens_out"      INT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "cm_conv_created_idx" ON "chatbot_messages" ("conversation_id", "created_at");

-- --- sessions ---------------------------------------------------------------
CREATE TABLE "sessions" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "kind"                TEXT NOT NULL CHECK ("kind" IN ('web', 'tray')),
  "issued_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at"          TIMESTAMPTZ(6) NOT NULL,
  "revoked_at"          TIMESTAMPTZ(6),
  "refresh_token_hash"  TEXT NOT NULL,
  "last_seen_at"        TIMESTAMPTZ(6),
  "user_agent"          TEXT,
  "ip"                  TEXT
);
CREATE INDEX "sessions_user_revoked_idx"    ON "sessions" ("user_id", "revoked_at");
CREATE INDEX "sessions_active_expires_idx"  ON "sessions" ("expires_at") WHERE "revoked_at" IS NULL;

-- --- notifications ----------------------------------------------------------
CREATE TABLE "notifications" (
  "id"         BIGSERIAL PRIMARY KEY,
  "user_id"    BIGINT NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "kind"       TEXT NOT NULL,
  "payload"    JSONB NOT NULL,
  "read_at"    TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "notif_user_read_created_idx" ON "notifications" ("user_id", "read_at", "created_at" DESC);

-- --- admin_email_allowlist --------------------------------------------------
CREATE TABLE "admin_email_allowlist" (
  "id"       BIGSERIAL PRIMARY KEY,
  "email"    CITEXT NOT NULL UNIQUE,
  "added_by" TEXT NOT NULL,
  "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- --- org_settings (singleton) -----------------------------------------------
CREATE TABLE "org_settings" (
  "id"                          INT PRIMARY KEY CHECK ("id" = 1),
  "reporting_currency"          CHAR(3) NOT NULL DEFAULT 'EUR',
  "default_timezone"            TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  "overtime_daily_hours"        NUMERIC(4, 2) NOT NULL DEFAULT 10.00,
  "overtime_weekly_hours"       NUMERIC(4, 2) NOT NULL DEFAULT 50.00,
  "anomaly_sigma"               NUMERIC(3, 2) NOT NULL DEFAULT 2.00,
  "chatbot_daily_token_budget"  INT NOT NULL DEFAULT 50000,
  "export_async_threshold"      INT NOT NULL DEFAULT 100000,
  "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_by"                  BIGINT REFERENCES "users" ("id") ON DELETE SET NULL
);

-- =============================================================================
-- Audit log append-only enforcement: trigger on UPDATE or DELETE
-- =============================================================================
CREATE OR REPLACE FUNCTION audit_log_block_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- =============================================================================
-- Audit log hash chain: BEFORE INSERT computes prev_row_hash + row_hash
-- =============================================================================
--
-- The chain works as follows:
--   - prev_row_hash = the row_hash of the most recently inserted audit_log row,
--     or '0000...000' (64 zeros) for the genesis row.
--   - row_hash = sha256(prev_row_hash || canonical_json(this row, sans row_hash))
--
-- The application can pre-compute prev_row_hash and row_hash and INSERT them
-- explicitly (recommended path — gives the app the row_hash for the response).
-- The trigger fills in only the values the app didn't provide, so it acts as
-- a safety net rather than the primary author.
--
-- The canonical-JSON used here is a stable representation of the row's
-- semantic content: id, actor_id, action, entity_type, entity_id, before,
-- after, reason, created_at (NOT prev_row_hash, NOT row_hash). The application
-- MUST use the same canonicalisation when verifying integrity.

CREATE OR REPLACE FUNCTION audit_log_hash_chain()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_prev_hash CHAR(64);
  v_canonical TEXT;
BEGIN
  -- Look up the prior row's hash (or the genesis sentinel).
  IF NEW.prev_row_hash IS NULL THEN
    SELECT row_hash INTO v_prev_hash
      FROM audit_log
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE;
    IF v_prev_hash IS NULL THEN
      v_prev_hash := repeat('0', 64); -- genesis
    END IF;
    NEW.prev_row_hash := v_prev_hash;
  END IF;

  -- If the application didn't pre-compute row_hash, compute it here using
  -- a stable JSON representation. Note: jsonb_build_object guarantees key
  -- order; jsonb is canonical for value comparison but not for raw bytes,
  -- so we use the text cast which Postgres normalises consistently within
  -- a single major version.
  IF NEW.row_hash IS NULL THEN
    v_canonical := jsonb_build_object(
      'actor_id',    NEW.actor_id,
      'action',      NEW.action,
      'entity_type', NEW.entity_type,
      'entity_id',   NEW.entity_id,
      'before',      NEW.before,
      'after',       NEW.after,
      'reason',      NEW.reason,
      'created_at',  to_char(COALESCE(NEW.created_at, NOW()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )::text;
    NEW.row_hash := encode(digest(NEW.prev_row_hash || v_canonical, 'sha256'), 'hex');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_hash_chain_trg
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_hash_chain();

-- =============================================================================
-- Helper SQL functions for the financial dashboard
-- =============================================================================
--
-- get_effective_cost_rate(user_id, on_date) → NUMERIC(10,2) or NULL
-- get_effective_billable_rate(project_id, task_id, on_date) → NUMERIC(10,2)
--
-- Both walk the effective-from / effective-to history. on_date is inclusive
-- of effective_from and exclusive of effective_to (matches the EXCLUDE
-- constraint's [) semantics on the daterange).

CREATE OR REPLACE FUNCTION get_effective_cost_rate(p_user_id BIGINT, p_on_date DATE)
RETURNS NUMERIC(10, 2) LANGUAGE sql STABLE AS $$
  SELECT rate
    FROM employee_cost_rates
    WHERE user_id = p_user_id
      AND effective_from <= p_on_date
      AND (effective_to IS NULL OR effective_to > p_on_date)
    ORDER BY effective_from DESC
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_effective_billable_rate(
  p_project_id BIGINT,
  p_task_id    BIGINT,
  p_on_date    DATE
)
RETURNS NUMERIC(10, 2) LANGUAGE sql STABLE AS $$
  -- Task-specific rate wins over project-default rate when both exist on the
  -- same date.
  WITH candidates AS (
    SELECT rate, task_id, effective_from
      FROM project_billable_rates
      WHERE project_id = p_project_id
        AND (task_id = p_task_id OR task_id IS NULL)
        AND effective_from <= p_on_date
        AND (effective_to IS NULL OR effective_to > p_on_date)
  )
  SELECT rate
    FROM candidates
    -- task-specific rate ranks above project-default
    ORDER BY (task_id IS NULL), effective_from DESC
    LIMIT 1;
$$;

-- =============================================================================
-- Bootstrap rows
-- =============================================================================
-- The org_settings singleton row must exist immediately. Subsequent seed runs
-- update it via the seed script.
INSERT INTO "org_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
