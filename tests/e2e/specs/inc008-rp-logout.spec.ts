/**
 * INC-008 (GitHub #11) — OIDC RP-initiated logout (LIVE-ONLY regression spec).
 *
 * THE BUG (pre-fix): `POST /v1/auth/logout` only revoked the LOCAL session
 * cookie and returned `{ ok: true }`; the web `handleSignOut` then did
 * `router.push('/login')`. The Keycloak SSO cookie (KEYCLOAK_SESSION /
 * KEYCLOAK_IDENTITY) was NEVER cleared, so the next login silently
 * re-authenticated the SAME user with no credentials prompt — you could not
 * switch users.
 *
 * THE FIX: `POST /v1/auth/logout` now returns
 *   `{ ok: true, logout_url: string | null }`
 * where `logout_url` is the IdP's discovered `end_session_endpoint` with
 * `client_id=<OIDC_CLIENT_ID>` and a server-built
 * `post_logout_redirect_uri=<WEB_ORIGIN>/login`. The web `handleSignOut` now
 * does a FULL-PAGE `window.location.assign(logout_url)` to end the Keycloak SSO
 * session (Keycloak then redirects back to `/login` per the allowlisted
 * post-logout redirect). Falls back to a local `/login` redirect when
 * `logout_url` is null/invalid (the null path is unit-covered, not exercised
 * here).
 *
 * The Keycloak realm (`infra/keycloak/realm.json`) allowlists
 * `http://localhost:3000/login` as a `post.logout.redirect.uris` value for
 * `harvoost-web`, so the post-logout redirect is accepted (without it Keycloak
 * rejects the redirect).
 *
 * WHAT THIS SPEC PROVES (the #11 acceptance criteria) — LIVE against the docker
 * stack (chromium-live, http://localhost:3000):
 *   1. Sign Out returns `200 { ok:true, logout_url:<non-null> }` pointing at the
 *      Keycloak end_session_endpoint with client_id + the /login
 *      post_logout_redirect_uri, AND the browser actually navigates to Keycloak
 *      and then lands back on /login. The session cookie is cleared (a follow-up
 *      `/v1/auth/me` → 401) — no INC-003/005 regression.
 *   2. Re-initiating login PRESENTS THE KEYCLOAK LOGIN FORM (username/password
 *      fields visible) — i.e. NO silent re-auth (this was the headline bug).
 *   3. From that form a DIFFERENT user (Bob) authenticates and the app lands as
 *      Bob (`/v1/auth/me` returns Bob) — NOT silently as Alice.
 *
 * Prerequisites (same as oidc-flow.spec.ts): docker compose stack up + healthy
 * (postgres, keycloak with the post-logout allowlist re-imported, api, web),
 * realm seeded. Run with `E2E_LIVE=1`.
 *
 * The hermetic project skips this entire file via the `test.skip(!isLiveMode())`
 * guard (the hermetic logout/fallback path is covered by auth.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { isLiveMode, KEYCLOAK_PASSWORDS } from '../fixtures/auth.js';
import { USERS, type FixtureUser } from '../fixtures/rbac.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const webBase = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000';
// The dev stack pins Keycloak's frontend hostname to `harvoost.localhost:8080`,
// so the issuer it advertises (and the authorize/end-session endpoints it hands
// back) live under that host — NOT `localhost:8080`. See oidc-flow.spec.ts for
// the full rationale.
const keycloakBase = process.env.E2E_KEYCLOAK_URL ?? 'http://harvoost.localhost:8080';

// ---------------------------------------------------------------------------
// Auth throttle pacing (identical discipline to oidc-flow.spec.ts).
//
// The backend AuthController is rate-limited at 5 requests / 60s per IP, and
// EVERY auth endpoint (idp-info, oidc/login, oidc/callback, /v1/auth/me, AND
// logout) shares that single budget. One full live login spends ~4 of the 5
// slots, so two logins cannot coexist in the same 60s fixed window. We pace
// login-bearing work one-per-window, anchored on the limiter's documented TTL
// (NOT a guessed sleep, and NOT by polling an auth endpoint — that would burn
// the very budget we are waiting to recover).
// ---------------------------------------------------------------------------
const AUTH_THROTTLE_TTL_MS = 60_000;
let lastAuthBudgetSpentAt = Date.now() - AUTH_THROTTLE_TTL_MS;

function markAuthBudgetSpent(): void {
  lastAuthBudgetSpentAt = Date.now();
}

async function waitForAuthWindow(): Promise<void> {
  const target = lastAuthBudgetSpentAt + AUTH_THROTTLE_TTL_MS + 1_500; // small guard
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

/** Single browser-context fetch of /v1/auth/me (carries the HttpOnly cookie). */
async function fetchMe(
  page: Page,
  baseUrl: string,
): Promise<{ status: number; body: any }> {
  return page.evaluate(async (api) => {
    const r = await fetch(`${api}/v1/auth/me`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return { status: r.status, body: await r.json() };
  }, baseUrl);
}

/**
 * Drive the dev Keycloak credentials form. Mirrors the hardened helper in
 * fixtures/auth.ts: the show/hide-password toggle's accessible name also
 * contains "password", so we anchor the password input by its stable `#password`
 * id and the username by the email/username textbox role.
 */
async function completeKeycloakLogin(
  page: Page,
  actor: FixtureUser,
  password: string,
): Promise<void> {
  await page.getByRole('textbox', { name: /email|username/i }).fill(actor.email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

/** Click the IdP sign-in button on /login (IdP-agnostic label per ADR-0001). */
async function clickContinueWithIdp(page: Page): Promise<void> {
  await page.getByRole('button', { name: /continue with .+/i }).click();
}

// Whole-file gate: live-only.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend (E2E_LIVE=1)');

// Serial: parallel logins would burst past the 5/60s auth throttle.
test.describe.configure({ mode: 'serial' });

test.describe('INC-008 — RP-initiated logout ends the Keycloak session (live, #11)', () => {
  test.beforeEach(async () => {
    // The pre-wait (up to a full throttle window) is added on top of the test's
    // own timeout so it never eats into the handshake budget. This test does
    // multiple logins/logouts, so it also waits a window mid-test.
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS * 2 + 10_000);
    await waitForAuthWindow();
  });
  test.afterEach(() => {
    markAuthBudgetSpent();
  });

  test(
    'Sign Out navigates to the IdP end_session_endpoint, the next login shows the Keycloak form, and a DIFFERENT user (Bob) can authenticate',
    async ({ page, context }) => {
      const alice = USERS.alice;
      const bob = USERS.bob;

      // =====================================================================
      // STEP 1 (part a) — Sign in as user A (Alice) via the real Keycloak.
      // =====================================================================
      await context.clearCookies();
      await page.goto('/login');
      await clickContinueWithIdp(page);
      await page.waitForURL(
        /\/realms\/[^/]+\/protocol\/openid-connect\/auth/,
        { timeout: 15_000 },
      );
      await completeKeycloakLogin(page, alice, KEYCLOAK_PASSWORDS.alice);
      // Backend completes the code exchange, sets the cookie, lands in the app.
      await page.waitForURL(/\/(timesheets|dashboard|chat|leave|approvals)/i, {
        timeout: 20_000,
      });

      // Confirm we are really Alice before logging out (anchors step 3's
      // "switched to Bob, not still Alice" assertion).
      const meAlice = await fetchMe(page, apiBase);
      expect(meAlice.status, 'Alice /me after live login').toBe(200);
      expect(
        (meAlice.body.email as string).toLowerCase(),
        'signed in as Alice',
      ).toBe(alice.email.toLowerCase());

      // The Sign out control is in the rendered shell (not the error boundary).
      const signOut = page.getByRole('button', { name: /sign out/i });
      await expect(signOut, 'shell exposes Sign out control').toBeVisible();

      // =====================================================================
      // STEP 1 (part b) — Click Sign Out; capture the logout RESPONSE and assert
      // the browser navigates to Keycloak then lands back on /login.
      // =====================================================================
      // Capture the full redirect chain so we can prove the browser actually
      // transited the Keycloak end_session_endpoint.
      const navUrls: string[] = [];
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navUrls.push(frame.url());
      });

      // Intercept POST /v1/auth/logout and EAGERLY buffer its status + body
      // BEFORE the page navigates. handleSignOut does a full-page
      // `window.location.assign(logout_url)` the instant the response resolves,
      // which tears down the page/network context — so a post-hoc
      // `response.json()` races the navigation and fails with "No resource with
      // given identifier". Capturing inside the route handler (fetch → read body
      // → fulfill) guarantees we hold the JSON before the redirect fires, while
      // still letting the REAL response (and Set-Cookie cookie-clear) reach the
      // browser so the rest of the live flow is unaffected.
      let captured: { status: number; body: { ok?: boolean; logout_url?: string | null } } | null =
        null;
      await page.route(/\/v1\/auth\/logout$/, async (route) => {
        const resp = await route.fetch();
        const status = resp.status();
        const json = (await resp.json()) as {
          ok?: boolean;
          logout_url?: string | null;
        };
        captured = { status, body: json };
        // Re-emit the real response verbatim (headers incl. Set-Cookie, body).
        await route.fulfill({ response: resp });
      });

      await signOut.click();
      await expect
        .poll(() => captured, { message: 'POST /v1/auth/logout was intercepted' })
        .not.toBeNull();
      const logout = captured as unknown as {
        status: number;
        body: { ok?: boolean; logout_url?: string | null };
      };

      // --- Assert the response status + shape ---
      // The pinned contract describes this as "200", but the NestJS @Post route
      // carries no @HttpCode(200) override, so the framework returns its default
      // 201 for a POST. The status code is incidental here — the load-bearing
      // contract is the JSON BODY shape ({ ok:true, logout_url:<non-null> }) and
      // the actual browser navigation. We accept any 2xx (observed: 201).
      const logoutStatus = logout.status;
      expect(
        logoutStatus >= 200 && logoutStatus < 300,
        `POST /v1/auth/logout → 2xx (observed ${logoutStatus})`,
      ).toBe(true);
      const logoutBody = logout.body;
      expect(logoutBody.ok, 'logout body { ok: true }').toBe(true);
      expect(
        logoutBody.logout_url,
        'logout_url is a non-null string (RP-initiated logout URL)',
      ).toEqual(expect.any(String));

      // --- Assert logout_url points at the Keycloak end_session_endpoint with
      //     the right client_id + post_logout_redirect_uri ---
      const logoutUrl = new URL(logoutBody.logout_url as string);
      // Host = the realm's stable issuer host (harvoost.localhost:8080), path =
      // the discovered end_session_endpoint (…/openid-connect/logout). We do not
      // hardcode the path beyond the provider-agnostic end-session shape.
      expect(
        `${logoutUrl.protocol}//${logoutUrl.host}`,
        'logout_url host = Keycloak issuer host',
      ).toBe(keycloakBase);
      expect(
        logoutUrl.pathname,
        'logout_url path = Keycloak end_session_endpoint',
      ).toBe('/realms/harvoost/protocol/openid-connect/logout');
      expect(
        logoutUrl.searchParams.get('client_id'),
        'logout_url carries client_id=harvoost-web',
      ).toBe('harvoost-web');
      expect(
        logoutUrl.searchParams.get('post_logout_redirect_uri'),
        'logout_url carries post_logout_redirect_uri=<web>/login',
      ).toBe(`${webBase}/login`);

      // --- Assert the browser actually transited Keycloak and landed on /login.
      // window.location.assign(logout_url) navigates to Keycloak's logout
      // endpoint. Because this is Option B (no id_token_hint is sent — see the
      // backend HANDOFF: no id_token persisted, no migration), Keycloak first
      // renders a logout-CONFIRMATION page ("Logging out / Do you want to log
      // out?" with a Logout button) rather than redirecting silently. A real
      // user clicks Logout; the SSO session is then ended and Keycloak redirects
      // back to the allowlisted post_logout_redirect_uri (the web /login). We
      // first land on the Keycloak logout endpoint, then click Logout to confirm.
      await page.waitForURL(
        /\/realms\/[^/]+\/protocol\/openid-connect\/logout/,
        { timeout: 20_000 },
      );
      const sawKeycloakLogout = navUrls.some(
        (u) =>
          u.startsWith(keycloakBase) &&
          u.includes('/protocol/openid-connect/logout'),
      );
      expect(
        sawKeycloakLogout,
        'browser navigated THROUGH the Keycloak end_session_endpoint',
      ).toBe(true);

      // Confirm the logout (Option B confirmation prompt). The button is
      // Keycloak's `<input type="submit" value="Logout">` on the logout-confirm
      // theme. After confirming, Keycloak ends the SSO session and redirects to
      // the post_logout_redirect_uri → the web /login.
      await page
        .getByRole('button', { name: /^logout$/i })
        .click();
      await page.waitForURL(/\/login(\?|#|$)/, { timeout: 20_000 });
      await expect(
        page,
        'after confirming logout, browser lands back on the web /login',
      ).toHaveURL(/\/login(\?|#|$)/);

      // --- No INC-003/005 regression: the local session cookie is gone, so
      //     /v1/auth/me now 401s. (Single call — does not poll, preserves
      //     budget.) ---
      const meAfterLogout = await fetchMe(page, apiBase);
      expect(
        meAfterLogout.status,
        'session cookie cleared on logout → /me 401',
      ).toBe(401);

      // =====================================================================
      // STEP 2 — Re-initiate login. The headline: the Keycloak LOGIN FORM is
      // presented (no silent re-auth as Alice). The SSO session is ended.
      //
      // This second login needs a fresh auth-throttle window (Alice's login +
      // logout already spent this window's budget). Wait one full TTL, anchored
      // on the limiter clock, before driving the re-login.
      // =====================================================================
      markAuthBudgetSpent();
      await waitForAuthWindow();

      await page.goto('/login');
      await clickContinueWithIdp(page);

      // PRE-FIX this would silently bounce straight back into the app as Alice
      // (Keycloak SSO cookie still valid → no credentials prompt). POST-FIX the
      // SSO session was ended, so the OIDC authorize redirect lands on the
      // Keycloak LOGIN PAGE and renders the credentials form.
      await page.waitForURL(
        /\/realms\/[^/]+\/protocol\/openid-connect\/auth/,
        { timeout: 15_000 },
      );
      const kcUsername = page.getByRole('textbox', { name: /email|username/i });
      const kcPassword = page.locator('#password');
      await expect(
        kcUsername,
        'Keycloak login form: username/email field is presented (no silent re-auth)',
      ).toBeVisible();
      await expect(
        kcPassword,
        'Keycloak login form: password field is presented (no silent re-auth)',
      ).toBeVisible();

      // =====================================================================
      // STEP 3 — Authenticate as a DIFFERENT user (Bob) from that form and
      // assert the app lands as Bob (NOT silently as Alice).
      // =====================================================================
      await completeKeycloakLogin(page, bob, KEYCLOAK_PASSWORDS.bob);
      await page.waitForURL(/\/(timesheets|dashboard|chat|leave|approvals)/i, {
        timeout: 20_000,
      });

      const meBob = await fetchMe(page, apiBase);
      expect(meBob.status, 'Bob /me after switch-user login').toBe(200);
      expect(
        (meBob.body.email as string).toLowerCase(),
        'app is now Bob — user switch succeeded (NOT silently Alice)',
      ).toBe(bob.email.toLowerCase());
      // Explicit negative: we are emphatically NOT still Alice.
      expect(
        (meBob.body.email as string).toLowerCase(),
        'definitely not still Alice',
      ).not.toBe(alice.email.toLowerCase());
      // Bob is an employee; the manager-only Approvals nav must be absent —
      // proves the shell re-rendered for Bob's identity/role, not Alice's.
      await expect(
        page.getByRole('button', { name: /sign out/i }),
        'Bob shell rendered (Sign out present, no error boundary)',
      ).toBeVisible();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    },
  );
});
