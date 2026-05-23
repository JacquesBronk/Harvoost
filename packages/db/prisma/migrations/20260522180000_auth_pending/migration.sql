-- =============================================================================
-- auth_pending migration — ADR-0001 (provider-agnostic OIDC)
-- =============================================================================
-- The OIDC login flow needs to hold state/nonce/code_verifier across the
-- browser redirect to the IdP and back. Cookies/localStorage are an option but
-- a server-side row is simpler to reason about and works identically for the
-- tray (which doesn't have a browser cookie store during the device flow).
--
-- Lifecycle:
--   1. POST /v1/auth/oidc/login inserts a row with state/nonce/code_verifier
--      and returns the row id (opaque_state_id) + the IdP authorization URL.
--   2. The browser is redirected to the IdP, then back to the frontend with
--      ?code&state. The frontend POSTs to /v1/auth/oidc/callback with
--      { code, state, opaque_state_id }.
--   3. The callback verifies opaque_state_id resolves to a row with matching
--      state and not-yet-expired (5 min TTL), exchanges the code for tokens
--      using the stored code_verifier, validates the id_token's nonce
--      matches, mints a session, and DELETEs the row (single-use).
--
-- A periodic cleanup is recommended (see packages/jobs) — the index on
-- expires_at supports a cheap purge of expired rows.
-- =============================================================================

CREATE TABLE auth_pending (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state         TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  client_kind   TEXT NOT NULL CHECK (client_kind IN ('web', 'tray')),
  redirect_uri  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_auth_pending_expires ON auth_pending(expires_at);
