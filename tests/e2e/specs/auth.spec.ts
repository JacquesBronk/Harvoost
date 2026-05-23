import { expect, test } from '@playwright/test';
import { installMockApi, SESSION_TOKEN } from '../fixtures/mock-api.js';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

// Per ADR-0001 (OIDC provider-agnostic), the sign-in flow now runs through
// the real Keycloak when E2E_LIVE=1 — these hermetic-mode-only specs are
// scoped to the mocked project. The live-only counterpart is in
// `oidc-flow.spec.ts` which drives the full Keycloak handshake end-to-end.
test.describe('Journey 1: OIDC sign-in (hermetic mock)', () => {
  test.skip(isLiveMode(), 'hermetic-only — see oidc-flow.spec.ts for live');

  test('unauthenticated landing redirects to /login', async ({ page, context }) => {
    // No mock-api installed — /v1/auth/me will fail with network error and
    // useCurrentUser returns null. The root page should redirect to /login.
    await context.clearCookies();
    await page.route(/\/v1\/auth\/me/, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'OIDC_FAILURE', message: 'No session' }),
      }),
    );
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to Harvoost' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
  });

  test('clicking "Continue with Microsoft" initiates the OIDC handshake', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    // Intercept /v1/auth/me as 401 so the shell stays in the login flow.
    await page.route(/\/v1\/auth\/me/, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'OIDC_FAILURE', message: 'No session' }),
      }),
    );
    // Intercept /v1/auth/oidc/login and respond with a same-origin redirect
    // back to /auth/callback so we can verify the next leg without leaving
    // the localhost frame.
    let loginCalled = false;
    await page.route(/\/v1\/auth\/oidc\/login/, async (route) => {
      loginCalled = true;
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorization_url: `${url.origin.replace(':3001', ':3000')}/auth/callback?code=mock-code&state=mock-state`,
          state: 'mock-state',
        }),
      });
    });

    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
    await expect.poll(() => loginCalled).toBe(true);
  });

  test('OIDC callback sets a HttpOnly session cookie via Set-Cookie and lands on /timesheets', async ({
    page,
    context,
  }) => {
    // Finding 7: the session token is now issued via a Set-Cookie HTTP
    // header — no document.cookie write happens in the page. The web
    // client only relies on `credentials: 'include'` from then on.
    await context.clearCookies();
    const handle = await installMockApi(page, {
      actorKey: 'bob',
      skipPreSeedSessionCookie: true,
    });
    // Capture the Set-Cookie header returned by the callback POST so we can
    // assert its shape directly (HttpOnly is otherwise invisible to JS).
    let setCookieHeader: string | null = null;
    page.on('response', (resp) => {
      if (resp.url().endsWith('/v1/auth/oidc/callback') && resp.request().method() === 'POST') {
        // Playwright joins multi-Set-Cookie headers with newline.
        setCookieHeader = resp.headers()['set-cookie'] ?? null;
      }
    });

    await page.goto('/auth/callback?code=mock-code&state=mock-state');
    await expect(page).toHaveURL(/\/timesheets$/);

    // Set-Cookie header shape: harvoost_session=<value>; HttpOnly; SameSite=Lax; Path=/.
    expect(setCookieHeader, 'POST /v1/auth/oidc/callback response includes Set-Cookie').not.toBeNull();
    expect(setCookieHeader!).toMatch(/^harvoost_session=/);
    expect(setCookieHeader!).toMatch(/HttpOnly/i);
    expect(setCookieHeader!).toMatch(/SameSite=Lax/i);
    expect(setCookieHeader!).toMatch(/Path=\//);

    // The browser's cookie jar now has the cookie marked httpOnly.
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'harvoost_session');
    expect(sessionCookie?.value).toBe(SESSION_TOKEN);
    expect(sessionCookie?.httpOnly, 'cookie must be HttpOnly').toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');

    // document.cookie MUST NOT expose the HttpOnly cookie.
    const docCookie = await page.evaluate(() => document.cookie);
    expect(docCookie).not.toContain('harvoost_session');

    void handle;
  });

  test('subsequent navigation reuses the cookie automatically (no client-side write)', async ({
    page,
    context,
  }) => {
    // Finding 7 follow-up: after the callback completes, navigating to a
    // protected route triggers /v1/auth/me with credentials:'include'. The
    // browser auto-attaches the cookie; the web client never writes it.
    await context.clearCookies();
    await installMockApi(page, { actorKey: 'bob', skipPreSeedSessionCookie: true });
    await page.goto('/auth/callback?code=mock-code&state=mock-state');
    await expect(page).toHaveURL(/\/timesheets$/);

    // Navigate to another protected page; /v1/auth/me must succeed.
    let meStatus: number | null = null;
    page.on('response', (resp) => {
      if (resp.url().endsWith('/v1/auth/me')) meStatus = resp.status();
    });
    await page.goto('/leave');
    await expect(page.getByRole('heading', { name: /^leave$/i })).toBeVisible();
    await expect.poll(() => meStatus).toBe(200);
  });

  test('GET /v1/auth/me returns user with roles + scope_meta after sign-in', async ({
    page,
  }) => {
    const handle = await signInAs(page, { actorKey: 'alice' });
    await expect(page.getByText('Alice Manager').first()).toBeVisible();
    // Sidebar shows the role badge.
    await expect(page.getByText(/^manager$/i)).toBeVisible();
    // Alice can see Manager-only nav items.
    await expect(page.getByRole('link', { name: 'Team' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
    expect(handle.state.actor.roles).toContain('manager');
  });
});

test.describe('Journey 1b: sign-out flow (Finding 7 + E6) — hermetic', () => {
  // The mock-state assertions (sessionActive, exact SESSION_TOKEN) cannot
  // be made against the live backend. The post-logout 401/redirect
  // assertion has a live counterpart in the describe block below.
  test.skip(isLiveMode(), 'hermetic-only — live counterpart below');

  test('sign-out POSTs /v1/auth/logout, clears the cookie, redirects to /login', async ({
    page,
    context,
  }) => {
    const handle = await signInAs(page, { actorKey: 'bob' });
    // Pre-condition: the session cookie is present in the jar.
    let cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'harvoost_session')?.value).toBe(SESSION_TOKEN);

    let logoutCalled = false;
    let logoutCreds: string | null = null;
    page.on('request', (req) => {
      if (req.url().endsWith('/v1/auth/logout') && req.method() === 'POST') {
        logoutCalled = true;
        logoutCreds = req.headers()['x-requested-with'] ?? null;
      }
    });

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);

    // (a) POST /v1/auth/logout was called.
    expect(logoutCalled).toBe(true);
    // (b) the request carried the CSRF header (paired with cookie auth).
    expect(logoutCreds).toBe('XMLHttpRequest');
    // (c) the server flipped sessionActive off (visible via state handle).
    expect(handle.state.sessionActive).toBe(false);
    // (d) the cookie jar no longer contains harvoost_session (or the value is empty).
    cookies = await context.cookies();
    const remaining = cookies.find((c) => c.name === 'harvoost_session');
    // Either absent OR present with an empty value (some browsers retain a
    // zero-value cookie until next nav). Both are acceptable; what we
    // definitively assert is that no value remains.
    expect(remaining?.value ?? '').toBe('');
  });

  test('after logout, calling a protected endpoint returns 401', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'bob' });
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);

    // The mock-api flips sessionActive off on logout; subsequent /v1/auth/me
    // calls now return 401 OIDC_FAILURE.
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/auth/me`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(401);
    expect((resp.body as { code: string }).code).toBe('OIDC_FAILURE');
    void handle;
  });
});

test.describe('Journey 1b: sign-out flow (Finding 7 + E6) — live', () => {
  // Live counterpart: after sign-out, navigating to a protected page must
  // redirect to /login (which then 302s to Keycloak). This is the shape the
  // real backend produces — there is no mock-state to peek at.
  test.skip(!isLiveMode(), 'live-only — hermetic counterpart above');

  test('after sign-out, navigating to a protected page redirects to /login → Keycloak', async ({
    page,
    context,
  }) => {
    await signInAs(page, { actorKey: 'bob' });
    // Pre-condition: protected page loads.
    await expect(page).toHaveURL(/\/timesheets$/);

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Cookie jar no longer contains a usable session.
    const cookies = await context.cookies();
    const remaining = cookies.find((c) => c.name === 'harvoost_session');
    expect(remaining?.value ?? '').toBe('');

    // Navigating to a protected route from /login goes back to /login (the
    // route-guard in AppShell sees no session). If the user clicks
    // "Continue with Microsoft" again it would redirect to Keycloak — we
    // assert the /login landing is enough here; the full re-login round-trip
    // is exercised by oidc-flow.spec.ts.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});
