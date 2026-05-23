-- ====================================================================
-- packages/db/prisma/init.sql
--
-- REFERENCE FILE — not executed by Prisma automatically.
--
-- This is the canonical "what does the schema actually look like at the
-- Postgres level" — the things Prisma cannot fully express:
--   * extensions (btree_gist, pgcrypto, citext)
--   * generated columns (time_entries.time_range)
--   * EXCLUDE constraints (time_entries, schedule_overrides, rate-history tables)
--   * partial unique indexes (te running, te idempotency, project_members active)
--   * audit_log mutation-block + hash-chain triggers
--   * helper SQL functions (get_effective_cost_rate, get_effective_billable_rate)
--   * the org_settings singleton bootstrap row
--
-- The AUTHORITATIVE copy of all of the above is in the timestamped migration:
--   prisma/migrations/20260522000000_init/migration.sql
--
-- This file exists so a reader who wants to understand the DB-level
-- constraints in isolation can do so without scrolling past 250 lines of
-- CREATE TABLE.
--
-- If you change something in the migration, update the relevant excerpt
-- here too — they MUST stay in sync. A linter PR-comment task can be
-- added later to enforce this.
-- ====================================================================

-- ---- Extensions ----------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---- time_entries: generated column + EXCLUDE + partial uniques ----
-- (excerpt; full table definition is in migration.sql)
--
-- time_range TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED;
--
-- CONSTRAINT te_no_overlap EXCLUDE USING gist (
--   user_id WITH =,
--   time_range WITH &&
-- ) WHERE (end_at IS NOT NULL);
--
-- CREATE UNIQUE INDEX te_one_running_per_user ON time_entries (user_id) WHERE status = 'running';
-- CREATE UNIQUE INDEX te_idempotency_unique ON time_entries (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---- audit_log: append-only enforcement ---------------------------
-- BEFORE UPDATE OR DELETE → RAISE EXCEPTION (audit_log_block_mutation()).
-- BEFORE INSERT → compute prev_row_hash + row_hash (audit_log_hash_chain()).
-- See migration.sql for the function bodies.

-- ---- Effective-rate helper functions -------------------------------
-- get_effective_cost_rate(user_id, on_date)         → NUMERIC(10,2)
-- get_effective_billable_rate(project_id, task_id, on_date) → NUMERIC(10,2)
--    (task-specific rate wins over project-default on overlap.)
