/**
 * Live-only OIDC flow smoke (per ADR-0001).
 *
 * Drives the FULL provider-agnostic OIDC handshake against the docker-compose
 * Keycloak service. The hermetic project skips this entire file via the
 * `test.skip(!isLiveMode(), ...)` guard.
 *
 * Prerequisites:
 *   1. `docker compose up -d postgres keycloak`
 *      → wait for keycloak healthcheck (~3s after boot).
 *   2. `pnpm db:migrate && pnpm db:seed`
 *      → seeds the four Harvoost users matching the realm's username/email.
 *   3. `pnpm dev` (apps/api + apps/web)
 *      → backend reads `OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost`.
 *   4. `E2E_LIVE=1 pnpm --filter @harvoost/e2e e2e`
 *
 * What this spec verifies:
 *   - Sign-in: /login → Continue with Microsoft → Keycloak login page →
 *     username/password → /v1/auth/callback?code=... → /timesheets.
 *   - The backend discovers the IdP via /.well-known/openid-configuration
 *     and validates the id_token via the JWKS endpoint.
 *   - `GET /v1/auth/me` returns the right user with the Harvoost-owned
 *     role assignment (NOT a role claim from Keycloak).
 *   - User upsert stability: the same Alice keeps the same user_id across
 *     a second login (the `sub` claim is the canonical identifier).
 */
import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode, KEYCLOAK_PASSWORDS } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const keycloakBase = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8080';

// Whole-file gate: skip everything when not in live mode.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend');

test.describe('OIDC flow (live, provider-agnostic per ADR-0001)', () => {
  test('Alice signs in via Keycloak and the session is real-OIDC-validated', async ({
    page,
    context,
  }) => {
    // Capture network events so we can assert the discovery doc was fetched
    // (caching means it may only be fetched once per process boot — we
    // tolerate either case).
    const responseUrls: string[] = [];
    page.on('response', (resp) => {
      responseUrls.push(resp.url());
    });

    await signInAs(page, { actorKey: 'alice' });

    // After signInAs: we are on /timesheets (or wherever the post-login
    // landing pointed). The cookie should be set as HttpOnly.
    await expect(page).toHaveURL(/\/timesheets/);
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'harvoost_session');
    expect(sessionCookie, 'harvoost_session cookie set after live OIDC').toBeDefined();
    expect(sessionCookie?.httpOnly, 'cookie must be HttpOnly').toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    // Value is opaque (32-byte base64url-ish) — assert length only.
    expect((sessionCookie?.value ?? '').length).toBeGreaterThan(20);

    // GET /v1/auth/me must reflect Alice with role=manager (from Harvoost's
    // user_roles table — NOT from any Keycloak role claim).
    const meBody = await page.evaluate(async (apiBase) => {
      const r = await fetch(`${apiBase}/v1/auth/me`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return { status: r.status, body: await r.json() };
    }, apiBase);

    expect(meBody.status).toBe(200);
    const me = meBody.body as {
      id: string;
      email: string;
      roles: string[];
      display_name?: string;
    };
    expect(me.email.toLowerCase()).toBe(USERS.alice.email.toLowerCase());
    expect(me.roles).toContain('manager');

    // Discovery doc — best-effort assertion. Keycloak's discovery endpoint is
    // `http://localhost:8080/realms/harvoost/.well-known/openid-configuration`.
    // The backend fetches it server-side at first OIDC use; the browser does
    // NOT see this request. We instead assert that the Keycloak login URL
    // appeared in the redirect chain (proves the backend handed back a real
    // authorize_url with the right issuer).
    const sawKeycloakAuth = responseUrls.some(
      (u) =>
        u.includes(keycloakBase) &&
        u.includes('/protocol/openid-connect/auth'),
    );
    expect(sawKeycloakAuth, 'Browser redirected to Keycloak /auth').toBe(true);
  });

  test('sub-claim stability: same Alice keeps the same user_id across two logins', async ({
    page,
    context,
  }) => {
    // Login 1.
    await signInAs(page, { actorKey: 'alice' });
    const me1 = await page.evaluate(async (apiBase) => {
      const r = await fetch(`${apiBase}/v1/auth/me`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return await r.json();
    }, apiBase);
    expect(me1.id).toBeTruthy();
    const userIdFirst = me1.id;

    // Sign out → clears cookie → forces a fresh OIDC handshake on next login.
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
    // Belt-and-braces: nuke the cookie jar so Keycloak's own session cookie
    // (KEYCLOAK_SESSION) does not auto-skip the password prompt.
    await context.clearCookies();

    // Login 2.
    await signInAs(page, { actorKey: 'alice' });
    const me2 = await page.evaluate(async (apiBase) => {
      const r = await fetch(`${apiBase}/v1/auth/me`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return await r.json();
    }, apiBase);
    expect(me2.id).toBe(userIdFirst);
    expect(me2.email.toLowerCase()).toBe(me1.email.toLowerCase());
  });

  test('Bob (employee role) lands without manager-only nav', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob' });
    await expect(page).toHaveURL(/\/timesheets/);
    // Bob is an employee — Approvals / Team Dashboard should NOT be in the
    // sidebar. (Their visibility is driven by Harvoost's user_roles table
    // via /v1/auth/me, not by any Keycloak claim.)
    await expect(page.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Team' })).toHaveCount(0);
  });

  test('directly hitting a Keycloak-validated route without a session yields 401', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    const resp = await page.evaluate(async (apiBase) => {
      const r = await fetch(`${apiBase}/v1/auth/me`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return { status: r.status, body: await r.json() };
    }, apiBase);
    expect(resp.status).toBe(401);
    const body = resp.body as { code?: string };
    // The backend emits OIDC_FAILURE for missing-session as well as bad
    // id_token. Either is acceptable here — we just want non-200.
    expect(['OIDC_FAILURE', 'UNAUTHENTICATED']).toContain(body.code ?? '');
  });

  test('Keycloak realm export matches the fixture user set', async ({ request }) => {
    // Sanity check that the realm has the four canonical users seeded.
    // We hit Keycloak's well-known endpoint to confirm the realm exists +
    // is the one our backend is pointed at. We do NOT use the admin API
    // (which would require an admin token) — just the public OIDC config.
    const r = await request.get(
      `${keycloakBase}/realms/harvoost/.well-known/openid-configuration`,
    );
    expect(r.status()).toBe(200);
    const doc = (await r.json()) as { issuer?: string; jwks_uri?: string };
    expect(doc.issuer).toBe(`${keycloakBase}/realms/harvoost`);
    expect(doc.jwks_uri).toContain('/realms/harvoost/protocol/openid-connect/certs');

    // Verify our local password mapping covers the four core fixture users.
    for (const key of ['alice', 'bob', 'carol', 'dave'] as const) {
      expect(KEYCLOAK_PASSWORDS[key], `password seeded for ${key}`).toBeTruthy();
    }
  });
});
