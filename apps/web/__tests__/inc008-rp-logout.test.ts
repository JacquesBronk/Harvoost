import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestLogout,
  resolveLogoutNavigation,
  type LogoutNavigation,
} from '../src/lib/logout.js';
import type { LogoutResponse } from '../src/lib/api-types.js';

/**
 * INC-008 (GitHub #11) regression — OIDC RP-initiated logout.
 *
 * Sign Out used to POST /v1/auth/logout then router.push('/login'), which only
 * cleared the LOCAL session cookie and never ended the Keycloak/IdP SSO session,
 * so the next login silently re-authenticated the SAME user. The backend now
 * returns `{ ok, logout_url }`; the web app must do a REAL full-page navigation
 * (window.location.assign) to that IdP end_session_endpoint to terminate SSO,
 * and fall back to a local /login redirect whenever there is no usable URL.
 *
 * The AppShell is a React client component that cannot render under this node
 * env, so — per the apps/web/__tests__ convention (see auth-me-loop.test.ts) —
 * the navigation-decision logic is extracted into the pure `resolveLogoutNavigation`
 * helper and the POST into `requestLogout`, both tested here without rendering.
 */

const IDP_LOGOUT_URL =
  'https://idp.example/realms/harvoost/protocol/openid-connect/logout?client_id=harvoost-web&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Flogin';

describe('resolveLogoutNavigation (INC-008: decide where Sign Out sends the browser)', () => {
  it('navigates to the IdP logout URL when logout_url is a non-empty https URL', () => {
    const nav = resolveLogoutNavigation({ ok: true, logout_url: IDP_LOGOUT_URL });
    expect(nav).toEqual<LogoutNavigation>({ kind: 'external', url: IDP_LOGOUT_URL });
  });

  it('navigates to the IdP logout URL for an http (not just https) origin', () => {
    const url = 'http://idp.local/logout?client_id=harvoost-web';
    const nav = resolveLogoutNavigation({ ok: true, logout_url: url });
    expect(nav).toEqual<LogoutNavigation>({ kind: 'external', url });
  });

  it('falls back to /login when logout_url is null (IdP has no end_session_endpoint)', () => {
    expect(resolveLogoutNavigation({ ok: true, logout_url: null })).toEqual<LogoutNavigation>(
      { kind: 'login' },
    );
  });

  it('falls back to /login when the request failed/threw (response is null)', () => {
    expect(resolveLogoutNavigation(null)).toEqual<LogoutNavigation>({ kind: 'login' });
  });

  it('falls back to /login for an empty-string logout_url', () => {
    expect(
      resolveLogoutNavigation({ ok: true, logout_url: '' as unknown as string }),
    ).toEqual<LogoutNavigation>({ kind: 'login' });
  });

  it('defense-in-depth: falls back to /login for a non-http(s) (e.g. relative or javascript:) URL', () => {
    expect(
      resolveLogoutNavigation({ ok: true, logout_url: '/login' }),
    ).toEqual<LogoutNavigation>({ kind: 'login' });
    expect(
      resolveLogoutNavigation({
        ok: true,
        logout_url: 'javascript:alert(1)' as unknown as string,
      }),
    ).toEqual<LogoutNavigation>({ kind: 'login' });
  });
});

describe('requestLogout (INC-008: POST /v1/auth/logout, CSRF + cookie preserved)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs with credentials + the X-Requested-With CSRF header and returns { ok, logout_url }', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, logout_url: IDP_LOGOUT_URL }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    globalThis.fetch = fetchMock;

    const result = await requestLogout();
    expect(result).toEqual<LogoutResponse>({ ok: true, logout_url: IDP_LOGOUT_URL });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/v1/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe(
      'XMLHttpRequest',
    );
  });

  it('returns a response with logout_url null when the IdP has no end_session_endpoint', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, logout_url: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    await expect(requestLogout()).resolves.toEqual<LogoutResponse>({
      ok: true,
      logout_url: null,
    });
  });

  it('returns null on a non-2xx response (caller falls back to /login)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(requestLogout()).resolves.toBeNull();
  });

  it('returns null when the fetch rejects/throws (network blip → caller falls back to /login)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(requestLogout()).resolves.toBeNull();
  });
});

/**
 * End-to-end of the sign-out DECISION (the two helpers composed exactly as
 * AppShell.handleSignOut composes them), proving the navigation target without
 * rendering React. window.location.assign + router.push are modeled as spies.
 */
describe('sign-out flow composition (INC-008: requestLogout → resolveLogoutNavigation → navigate)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function runSignOut() {
    const assign = vi.fn();
    const routerPush = vi.fn();
    const response = await requestLogout();
    const nav = resolveLogoutNavigation(response);
    if (nav.kind === 'external') {
      assign(nav.url);
    } else {
      routerPush('/login');
    }
    return { assign, routerPush };
  }

  it('navigates the browser to the IdP logout URL when one is returned', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, logout_url: IDP_LOGOUT_URL }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { assign, routerPush } = await runSignOut();
    expect(assign).toHaveBeenCalledWith(IDP_LOGOUT_URL);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('falls back to router.push(/login) when logout_url is null', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, logout_url: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { assign, routerPush } = await runSignOut();
    expect(routerPush).toHaveBeenCalledWith('/login');
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to router.push(/login) when the logout request rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const { assign, routerPush } = await runSignOut();
    expect(routerPush).toHaveBeenCalledWith('/login');
    expect(assign).not.toHaveBeenCalled();
  });
});
