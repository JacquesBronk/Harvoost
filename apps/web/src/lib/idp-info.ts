// IdP-agnostic display copy for the sign-in page (ADR-0001).
//
// The login page MUST NOT hardcode a provider name (e.g. "Microsoft Entra ID").
// Dev runs against Keycloak; prod runs against Entra; either is just an OIDC
// issuer chosen by `OIDC_ISSUER_URL` server-side. The web app discovers the
// human-facing provider name at runtime via the public, unauthenticated
// endpoint `GET /v1/auth/idp-info` → `{ display_name, issuer }`.
//
// These helpers keep the copy-derivation pure and testable in the node-env
// vitest setup (no React render needed).

/** Shape returned by GET /v1/auth/idp-info (public / unauthenticated). */
export interface IdpInfo {
  display_name: string;
  issuer: string;
}

/**
 * Neutral fallback used until `/v1/auth/idp-info` resolves, or if it errors.
 * The sign-in button must remain usable in either case, so we never block on
 * the fetch — we render neutral copy and swap in the real name when it arrives.
 */
export const IDP_FALLBACK_NAME = 'your identity provider';

/**
 * Resolve the IdP name to show in copy. Trims and falls back to the neutral
 * label when the endpoint is unavailable or returns a blank display_name.
 */
export function resolveIdpName(info: IdpInfo | null | undefined): string {
  const name = info?.display_name?.trim();
  return name && name.length > 0 ? name : IDP_FALLBACK_NAME;
}

/** Card copy beneath the heading. Provider-neutral in shape. */
export function idpCardCopy(name: string): string {
  return `Use your work account. Authentication is handled by ${name}; multi-factor authentication is enforced through your organisation's policy.`;
}

/** Primary sign-in button label. */
export function idpButtonLabel(name: string): string {
  return `Continue with ${name}`;
}
