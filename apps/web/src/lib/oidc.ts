// Shared constants for the web OIDC round-trip (ADR-0001).

/**
 * sessionStorage key under which the opaque state id from POST /v1/auth/oidc/login
 * is stashed between the /login leg and the /auth/callback leg of the round-trip.
 *
 * The backend's OidcCallbackSchema requires `opaque_state_id` on the callback POST;
 * the login page persists it before the IdP hand-off and the callback page reads +
 * clears it (single-use) before exchanging the code for a session.
 */
export const OIDC_OPAQUE_STATE_KEY = 'oidc_opaque_state_id';
