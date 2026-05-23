-- =============================================================================
-- audit_hmac migration — Finding 6 (CRITICAL, review loop attempt 1/2)
-- =============================================================================
-- Converts the audit_log hash chain from plain SHA-256 to HMAC-SHA-256 keyed
-- with the per-session GUC "app.audit_hash_secret". The secret is set by the
-- application at connection-open time via:
--
--     SET LOCAL app.audit_hash_secret = '<AUDIT_HASH_SECRET env var>';
--
-- BEFORE INSERT, the trigger reads the secret, raises if absent or too short,
-- computes prev_row_hash from the most recent row, canonicalises the new row,
-- and assigns row_hash = encode(hmac(prev_row_hash || canonical, secret,
-- 'sha256'), 'hex').
--
-- Threat model:
--   The previous SHA-256 chain was forgeable by anyone with DB write access
--   (DISABLE TRIGGER → tamper → recompute → ENABLE TRIGGER, no secret).
--   The HMAC variant requires the AUDIT_HASH_SECRET, which is held only in
--   the app process memory (and Azure Key Vault), never persisted in the DB.
--
-- Greenfield assumption:
--   audit_log is empty at migration time — no rows are deployed yet. If this
--   migration is applied against a populated audit_log, existing rows' row_hash
--   values will NOT recompute under the new algorithm. The audit-log-integrity
--   job (M5/Finding 11) will flag the boundary row as the chain's restart
--   point; that is the intended behaviour — explicit, observable discontinuity
--   beats silent forgeability.
--
-- App contract change:
--   The trigger is now the SOLE authority on row_hash. Callers MUST NOT
--   pre-compute or supply row_hash on INSERT — the trigger overwrites NEW
--   .row_hash unconditionally. Likewise prev_row_hash is computed by the
--   trigger (any caller-supplied value is overwritten). Inserts that omit
--   both columns are accepted because the BEFORE INSERT trigger fills them
--   before the NOT NULL check fires.
--
-- Append-only enforcement (audit_log_no_update, audit_log_no_delete triggers
-- from the init migration) is UNAFFECTED — those are separate triggers and
-- remain in place.
--
-- Rollback (DOWN):
--   See "DOWN MIGRATION" comment block at the bottom of this file. Restore
--   by re-applying the body of audit_log_hash_chain() from migration
--   20260522000000_init (lines 514-554) verbatim — that re-installs the
--   plain SHA-256 path. There is no automatic DOWN; if rollback is required,
--   apply the DOWN block manually via psql.
-- =============================================================================

-- (a) Drop the existing hash-chain trigger and function.
--     The append-only triggers (audit_log_no_update, audit_log_no_delete) are
--     deliberately NOT touched.
DROP TRIGGER IF EXISTS "audit_log_hash_chain_trg" ON "audit_log";
DROP FUNCTION IF EXISTS audit_log_hash_chain();

-- (b) Re-create the function using HMAC-SHA-256 with the per-session secret.
CREATE OR REPLACE FUNCTION audit_log_hash_chain()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_prev_hash CHAR(64);
  v_canonical TEXT;
  v_secret    TEXT;
BEGIN
  -- Pull the per-session secret. current_setting(name, false) raises
  -- 'unrecognized configuration parameter' if the GUC is unset. We add an
  -- explicit length floor for defence in depth (rejects empty strings and
  -- predictable dev placeholders).
  BEGIN
    v_secret := current_setting('app.audit_hash_secret', false);
  EXCEPTION WHEN undefined_object THEN
    RAISE EXCEPTION 'audit_log INSERT requires app.audit_hash_secret session GUC; set via "SET LOCAL app.audit_hash_secret = ?"'
      USING ERRCODE = 'insufficient_privilege';
  END;

  IF v_secret IS NULL OR length(v_secret) < 32 THEN
    RAISE EXCEPTION 'app.audit_hash_secret must be set and >= 32 chars'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Look up the prior row's hash (or the genesis sentinel — 64 zeros).
  -- The trigger is the sole authority; any caller-supplied prev_row_hash
  -- is overwritten to prevent fork-attack injection at the API boundary.
  SELECT row_hash INTO v_prev_hash
    FROM audit_log
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE;
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64); -- genesis
  END IF;
  NEW.prev_row_hash := v_prev_hash;

  -- Canonical JSON of the row, matching the column set used by the init-
  -- migration trigger (actor_id, action, entity_type, entity_id, before,
  -- after, reason, created_at). row_hash and prev_row_hash are excluded
  -- to avoid self-reference. jsonb_build_object guarantees key order; the
  -- ::text cast is stable within a Postgres major version (the integrity
  -- job MUST use the same canonicalisation for verification).
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

  -- HMAC-SHA-256 keyed with the session secret. The trigger is the sole
  -- authority — any caller-supplied row_hash is overwritten.
  NEW.row_hash := encode(hmac(NEW.prev_row_hash || v_canonical, v_secret, 'sha256'), 'hex');

  RETURN NEW;
END;
$$;

-- (c) Re-attach the BEFORE INSERT trigger. Name preserved from init migration
--     for grep-ability and ORM-tooling stability.
CREATE TRIGGER "audit_log_hash_chain_trg"
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_hash_chain();

-- =============================================================================
-- DOWN MIGRATION (manual — apply via psql if rollback is required)
-- =============================================================================
-- DROP TRIGGER IF EXISTS "audit_log_hash_chain_trg" ON "audit_log";
-- DROP FUNCTION IF EXISTS audit_log_hash_chain();
--
-- CREATE OR REPLACE FUNCTION audit_log_hash_chain()
-- RETURNS TRIGGER LANGUAGE plpgsql AS $$
-- DECLARE
--   v_prev_hash CHAR(64);
--   v_canonical TEXT;
-- BEGIN
--   IF NEW.prev_row_hash IS NULL THEN
--     SELECT row_hash INTO v_prev_hash
--       FROM audit_log
--       ORDER BY id DESC
--       LIMIT 1
--       FOR UPDATE;
--     IF v_prev_hash IS NULL THEN
--       v_prev_hash := repeat('0', 64);
--     END IF;
--     NEW.prev_row_hash := v_prev_hash;
--   END IF;
--
--   IF NEW.row_hash IS NULL THEN
--     v_canonical := jsonb_build_object(
--       'actor_id',    NEW.actor_id,
--       'action',      NEW.action,
--       'entity_type', NEW.entity_type,
--       'entity_id',   NEW.entity_id,
--       'before',      NEW.before,
--       'after',       NEW.after,
--       'reason',      NEW.reason,
--       'created_at',  to_char(COALESCE(NEW.created_at, NOW()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
--     )::text;
--     NEW.row_hash := encode(digest(NEW.prev_row_hash || v_canonical, 'sha256'), 'hex');
--   END IF;
--
--   RETURN NEW;
-- END;
-- $$;
--
-- CREATE TRIGGER "audit_log_hash_chain_trg"
--   BEFORE INSERT ON "audit_log"
--   FOR EACH ROW EXECUTE FUNCTION audit_log_hash_chain();
