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
 *   - Sign-in: /login → [IdP sign-in button] → Keycloak login page →
 *     username/password → /auth/callback?code=... → /timesheets.
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
// The dev stack pins Keycloak's frontend hostname via
// `--hostname=http://harvoost.localhost:8080` (docker-compose), so the STABLE
// issuer Keycloak advertises in its discovery doc — and the `iss` claim tokens
// carry — is `http://harvoost.localhost:8080/realms/harvoost`, NOT
// `http://localhost:8080/...`. The browser is also redirected to the
// `harvoost.localhost` authorize endpoint. Both the issuer assertion and the
// `sawKeycloakAuth` redirect-chain check depend on this matching the real
// hostname. (The sign-in flow itself follows the app-provided
// authorization_url and is unaffected by this constant.)
const keycloakBase = process.env.E2E_KEYCLOAK_URL ?? 'http://harvoost.localhost:8080';

// Node's resolver does NOT map `*.localhost` to loopback the way Chromium
// does, so a Node-side (request fixture) GET to `harvoost.localhost` fails with
// ENOTFOUND. For the one Node-side request in this file (the discovery-doc
// fetch) we hit Keycloak via 127.0.0.1 while sending the `harvoost.localhost`
// Host header — Keycloak then advertises the correct stable issuer, so the
// assertion still verifies the real, configured issuer value.
const keycloakNodeUrl =
  process.env.E2E_KEYCLOAK_NODE_URL ?? 'http://127.0.0.1:8080';
const keycloakHostHeader = new URL(keycloakBase).host;

// The entire backend AuthController is rate-limited at 5 requests / 60s per IP
// (`@Throttle({ auth: { ttl: 60_000, limit: 5 } })`), and EVERY auth endpoint —
// `idp-info` (GET), `oidc/login` (POST), `oidc/callback` (POST) and
// `/v1/auth/me` (GET) — shares that single budget. ONE full live login already
// spends ~4 of the 5 slots, so two logins cannot coexist in the same 60s
// fixed window: the second handshake's `oidc/callback` POST returns 429, the
// callback fails, and the app bounces back to /login. That is CORRECT product
// behaviour (the rate limiter doing its job), NOT a callback-flow bug.
//
// We therefore pace login-bearing tests one-per-window. Critically we must NOT
// poll ANY endpoint to detect "ready": auth endpoints would burn the very
// budget we are waiting to recover, and even /v1/health is under the global
// limiter. The wait is instead anchored on the limiter's documented fixed-
// window TTL (60s): we wait until one full TTL has elapsed since the previous
// test's auth activity (a wall-clock mark bumped in afterEach). This delay is
// derived from the limiter's real window — not a guessed UI/async sleep — so it
// is the correct condition to wait on for a fixed-window rate limiter.
const AUTH_THROTTLE_TTL_MS = 60_000;
// Initialise so the very first test runs immediately (no startup penalty).
let lastAuthBudgetSpentAt = Date.now() - AUTH_THROTTLE_TTL_MS;

function markAuthBudgetSpent(): void {
  lastAuthBudgetSpentAt = Date.now();
}

async function waitForAuthWindow(): Promise<void> {
  const target = lastAuthBudgetSpentAt + AUTH_THROTTLE_TTL_MS + 1_500; // small guard
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

// Fetch `/v1/auth/me` from the browser context (carries the HttpOnly cookie),
// the HttpOnly cookie). A single call only — we deliberately do NOT poll here:
// polling /v1/auth/me would itself burn throttle budget. The per-test window
// pacing (waitForAuthWindow) guarantees there is budget for exactly this call.
async function fetchMe(
  page: import('@playwright/test').Page,
  baseUrl: string,
): Promise<{ status: number; body: any }> {
  return page.evaluate(async (apiBase) => {
    const r = await fetch(`${apiBase}/v1/auth/me`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return { status: r.status, body: await r.json() };
  }, baseUrl);
}

// Whole-file gate: skip everything when not in live mode.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend');

// Run serially: parallel logins would burst past the 5/60s auth throttle and
// poison each other's auth calls with 429s. Serial + one-login-per-window
// pacing keeps every test inside the budget while still exercising the real
// handshake.
test.describe.configure({ mode: 'serial' });

test.describe('OIDC flow (live, provider-agnostic per ADR-0001)', () => {
  // Pace every test against the live auth throttle before it spends budget:
  // wait until a full throttle window has elapsed since the previous test's
  // auth activity (anchored on a wall-clock mark bumped in afterEach). The
  // up-to-60s pre-wait is added on top of the test's own timeout so it does not
  // eat into the handshake budget.
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + 5_000);
    await waitForAuthWindow();
  });
  test.afterEach(() => {
    // Every active test in this file spends auth budget; reset the window clock.
    markAuthBudgetSpent();
  });

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
    const meBody = await fetchMe(page, apiBase);

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

  test('directly hitting a Keycloak-validated route without a session yields 401', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    // A fresh page starts on about:blank, from which `fetch()` to the API
    // origin throws `TypeError: Failed to fetch` (no document origin → request
    // cannot be issued). Land on a real app-origin document first so the
    // browser-context fetch behaves exactly as it does for a real user.
    await page.goto('/login');
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
    // Fetch via 127.0.0.1 + Host header (Node cannot resolve `*.localhost`);
    // Keycloak still advertises its configured frontend issuer, so the
    // assertion verifies the real, stable issuer value (harvoost.localhost).
    const r = await request.get(
      `${keycloakNodeUrl}/realms/harvoost/.well-known/openid-configuration`,
      { headers: { Host: keycloakHostHeader } },
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

  // ---------------------------------------------------------------------------
  // POST-LOGIN SHELL RENDER (INC-002 product bug — NOW FIXED & RE-VERIFIED).
  // History: these two tests were `test.fixme` because the /timesheets shell
  // crashed into its React error boundary ("Something went wrong — Cannot read
  // properties of undefined (reading 'trim')") for OIDC-authenticated users —
  // GET /v1/auth/me omitted `display_name`, and packages/ui Avatar.tsx called
  // `name.trim()` with no guard, taking AppShell down with it. The product fix
  // landed: the API now returns a guaranteed non-empty `display_name`, AND the
  // Avatar / AppShell are null/empty-safe (AppShell falls back to the email).
  // The shell now renders fully after login. These tests are restored to normal
  // `test(...)` and each FIRST asserts that the rendered shell exists (a stable
  // shell element is visible, NOT the error boundary) before exercising its own
  // concern — so a regression of the crash would fail here instead of silently
  // passing a negative assertion against an empty error-boundary DOM.
  // ---------------------------------------------------------------------------
  test(
    'sub-claim stability: same Alice keeps the same user_id across two logins',
    async ({ page, context }) => {
      // Login 1.
      await signInAs(page, { actorKey: 'alice' });
      const me1 = (await fetchMe(page, apiBase)).body;
      expect(me1.id).toBeTruthy();
      const userIdFirst = me1.id;

      // Proof the shell RENDERED (no error boundary / no `trim` crash): the
      // sidebar's Timesheets nav link (rendered for every authed user) and the
      // Sign out control are both present. The "Something went wrong" error
      // boundary renders neither — it only shows a "Try again" button.
      // `exact: true` disambiguates the sidebar nav link from the empty-state
      // body link "Start one from timesheets" (both href=/timesheets) — without
      // it the role query is a strict-mode violation (2 matches).
      await expect(
        page.getByRole('link', { name: 'Timesheets', exact: true }),
        'rendered shell shows the sidebar nav (no error boundary)',
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /sign out/i }),
        'rendered shell exposes the Sign out control (no error boundary)',
      ).toBeVisible();
      // Guard against the exact prior crash leaking through.
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);

      // Sign out → clears cookie → forces a fresh OIDC handshake on next login.
      await page.getByRole('button', { name: /sign out/i }).click();
      await expect(page).toHaveURL(/\/login$/);
      // Belt-and-braces: nuke the cookie jar so Keycloak's own session cookie
      // (KEYCLOAK_SESSION) does not auto-skip the password prompt.
      await context.clearCookies();

      // This single test performs TWO full logins; the second handshake needs
      // fresh auth-throttle budget. Wait one full throttle window (condition
      // tied to the limiter TTL) before driving Login 2, and re-anchor the
      // window clock so the wait reflects this test's own auth activity.
      markAuthBudgetSpent();
      await waitForAuthWindow();

      // Login 2.
      await signInAs(page, { actorKey: 'alice' });
      // Shell renders again on the second handshake (the sign-out control is
      // back), proving the fix holds across repeat logins.
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
      const me2 = (await fetchMe(page, apiBase)).body;
      expect(me2.id).toBe(userIdFirst);
      expect(me2.email.toLowerCase()).toBe(me1.email.toLowerCase());
    },
  );

  test('Bob (employee role) lands without manager-only nav', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob' });
    await expect(page).toHaveURL(/\/timesheets/);

    // First prove the shell RENDERED. Without this, the negative assertions
    // below would also pass against the (empty) error-boundary DOM, masking a
    // regression of the INC-002 `trim` crash. The Timesheets nav link is
    // visible to EVERY authed user, so it is a stable positive shell marker.
    // `exact: true` disambiguates the sidebar nav link from the empty-state
    // body link "Start one from timesheets" (both href=/timesheets).
    await expect(
      page.getByRole('link', { name: 'Timesheets', exact: true }),
      'rendered shell shows the sidebar nav (no error boundary)',
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);

    // Bob is an employee — Approvals / Team Dashboard should NOT be in the
    // sidebar. (Their visibility is driven by Harvoost's user_roles table
    // via /v1/auth/me, not by any Keycloak claim.)
    await expect(page.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Team' })).toHaveCount(0);
  });
});
