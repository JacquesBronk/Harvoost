// INC-008 (GitHub #11) — OIDC RP-initiated logout (web side).
//
// Sign Out used to POST /v1/auth/logout then router.push('/login'), which only
// cleared the LOCAL session cookie and never ended the Keycloak/IdP SSO session
// — so the next login silently re-authenticated the same user. The backend now
// returns an IdP `end_session_endpoint` URL; the web app must do a real,
// full-page browser navigation to it so the SSO session is actually terminated
// (the IdP then redirects back to the web /login per post_logout_redirect_uri).
//
// The decision logic is extracted as a pure helper so it is testable under the
// node-env apps/web/__tests__ convention without rendering the React AppShell.

import { env } from './env.js';
import type { LogoutResponse } from './api-types.js';

/**
 * Where the sign-out flow should send the browser after POST /v1/auth/logout.
 *
 *  - `external` → a real, full-page navigation (window.location.assign) to the
 *    IdP `end_session_endpoint`. Must be an absolute http(s) URL on an external
 *    origin so the SSO cookie is cleared; router.push would NOT leave the SPA.
 *  - `login` → a local SPA redirect to /login. The fallback whenever there is
 *    no usable IdP logout URL: a `null`/empty logout_url, an IdP without an
 *    end_session_endpoint, a non-http(s) value, OR a failed/thrown request — so
 *    a network blip never strands the user looking logged-in.
 */
export type LogoutNavigation =
  | { kind: 'external'; url: string }
  | { kind: 'login' };

/**
 * Defense-in-depth (per the INC-008 security note): the backend builds the
 * logout URL from trusted config, but before handing it to window.location we
 * assert it is a non-empty absolute http(s):// URL. Anything else falls back to
 * the local /login redirect rather than navigating somewhere unexpected.
 */
function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Pure decision: given the parsed logout response (or `null` when the request
 * failed/threw), decide where to navigate.
 *
 *   { ok, logout_url: 'https://idp.example/...' } → external navigation
 *   logout_url null / empty / non-http(s) / request failed (null) → /login
 */
export function resolveLogoutNavigation(
  response: LogoutResponse | null,
): LogoutNavigation {
  if (response && isAbsoluteHttpUrl(response.logout_url)) {
    return { kind: 'external', url: response.logout_url };
  }
  return { kind: 'login' };
}

/**
 * POST /v1/auth/logout to revoke the local session and obtain the IdP logout
 * URL. Preserves the INC-001/002/003 CSRF + cookie behavior: credentials are
 * included so the HttpOnly session cookie is sent, and the
 * `X-Requested-With: XMLHttpRequest` header pairs with the backend CSRF guard.
 *
 * Returns the parsed `{ ok, logout_url }` on a 2xx with a JSON body, or `null`
 * for ANY failure (non-2xx, non-JSON, network error / thrown). A `null` return
 * means the caller falls back to the local /login redirect.
 */
export async function requestLogout(): Promise<LogoutResponse | null> {
  try {
    const res = await fetch(`${env.API_BASE_URL.replace(/\/$/, '')}/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<LogoutResponse> | null;
    if (!data || typeof data !== 'object') return null;
    return {
      ok: data.ok === true,
      logout_url: typeof data.logout_url === 'string' ? data.logout_url : null,
    };
  } catch {
    // Network failure / non-JSON body — non-fatal; caller redirects to /login.
    return null;
  }
}
