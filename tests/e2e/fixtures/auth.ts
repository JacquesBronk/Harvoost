/**
 * Auth helpers — sign in as a fixture user and navigate to the home shell.
 *
 * Per ADR-0001 (OIDC provider-agnostic; Keycloak in dev, Entra in prod), the
 * `X-Mock-User-Id` header bypass has been removed from the real backend.
 * This helper now has TWO implementations selected at runtime:
 *
 *   - **Hermetic (default)** — installs the in-process mock-api (which speaks
 *     real session-cookie semantics) and seeds the session by driving the
 *     mock-api's OIDC callback. The mock-api sets `harvoost_session` via
 *     Set-Cookie just like the real backend does. The web app shell loads
 *     under a real Next.js runtime; only the API origin is intercepted.
 *
 *   - **Live (`E2E_LIVE=1`)** — drives the real Keycloak login flow:
 *       /login -> Continue with Microsoft -> Keycloak login page ->
 *       username/password -> /v1/auth/callback?code=... -> /timesheets.
 *     The backend validates the id_token via `jose` against the issuer
 *     discovery doc, mints the session, and sets the HttpOnly cookie.
 *     Keycloak must already be running (docker compose up -d keycloak).
 *
 * Spec files do not need to know which mode is active — they call
 * `signInAs(page, { actorKey: 'bob' })` and we do the right thing.
 */

import type { Page } from '@playwright/test';
import { installMockApi, type InstallMockApiOpts, type MockApiHandle } from './mock-api.js';
import { USERS, type FixtureUser } from './rbac.js';

export interface SignInAsOpts extends InstallMockApiOpts {
  /** Where to land after sign-in. Defaults to /timesheets. */
  landingPath?: string;
}

/**
 * Default dev passwords from the Keycloak realm seed
 * (`infra/keycloak/harvoost-realm.json` per ADR-0001 § 3). Keep aligned with
 * devops' realm export. Convention: `dev-${actorKey}-pass`.
 *
 * The ADR proposed `Alice123!` / `Bob123!` / etc; devops elected to use a
 * uniform `dev-${name}-pass` shape so the values are predictable from the
 * fixture key. Either shape works for these tests — the source of truth is
 * the realm.json import.
 */
export const KEYCLOAK_PASSWORDS: Record<FixtureUser['key'], string> = {
  admin: 'dev-admin-pass',
  finmgr: 'dev-finmgr-pass',
  alice: 'dev-alice-pass',
  erin: 'dev-erin-pass',
  frank: 'dev-frank-pass',
  bob: 'dev-bob-pass',
  carol: 'dev-carol-pass',
  dave: 'dev-dave-pass',
  grace: 'dev-grace-pass',
};

export function isLiveMode(): boolean {
  return process.env.E2E_LIVE === '1';
}

/**
 * Drive the dev Keycloak login flow. Caller must already be on or have just
 * been redirected to the Keycloak login page (we wait for the URL to match).
 */
async function completeKeycloakLogin(
  page: Page,
  actor: FixtureUser,
  password: string,
): Promise<void> {
  // Wait for the URL to land on Keycloak. The redirect chain is:
  //   /login -> [Continue with Microsoft] -> POST /v1/auth/oidc/login
  //   -> 302 to Keycloak's /realms/<realm>/protocol/openid-connect/auth?...
  await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/, {
    timeout: 15_000,
  });
  // Keycloak's default login template uses `<input id="username">` /
  // `<input id="password">` (no <label>). Both `getByLabel` (it has a
  // <label for="username">) and `locator('#username')` work — we prefer
  // `getByLabel` for accessibility-rooted selection per playbook.
  const usernameField = page.getByLabel(/username or email|username|email/i);
  await usernameField.fill(actor.email);
  await page.getByLabel(/password/i).fill(password);
  // Keycloak's submit is `<input type="submit" name="login" value="Sign In">`.
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

/**
 * Sign the actor in. Returns the mock-api handle in hermetic mode; in live
 * mode returns a stub handle (`state` and `requests` are empty because there
 * is no in-process mock to inspect — assertions in live mode must come from
 * the real network log via `page.on('response', ...)`).
 */
export async function signInAs(
  page: Page,
  opts: SignInAsOpts,
): Promise<MockApiHandle> {
  const landing = opts.landingPath ?? '/timesheets';

  if (isLiveMode()) {
    // Live path — real Keycloak handshake.
    const actor = USERS[opts.actorKey];
    const password = KEYCLOAK_PASSWORDS[opts.actorKey];
    if (!password) {
      throw new Error(
        `signInAs (live): no Keycloak password seeded for actorKey=${opts.actorKey}. ` +
          `Add to KEYCLOAK_PASSWORDS or the realm import.`,
      );
    }
    await page.goto('/login');
    await page.getByRole('button', { name: /continue with microsoft|sign in/i }).click();
    await completeKeycloakLogin(page, actor, password);
    // Backend completes the code exchange and sets the cookie; user lands on
    // /timesheets (or wherever the original deep link wanted to go).
    await page.waitForURL(/\/(timesheets|dashboard|chat|leave|approvals)/i, {
      timeout: 20_000,
    });
    if (landing && !page.url().endsWith(landing)) {
      await page.goto(landing);
    }
    // Return a stub handle so call sites that don't use it still type-check.
    return {
      state: {
        actor,
      } as MockApiHandle['state'],
      requests: [],
      setEntryStatus() {
        throw new Error(
          'setEntryStatus is not supported in live mode — drive the real API instead.',
        );
      },
    };
  }

  // Hermetic path — install mock-api, navigate to landing, mock-api has
  // already pre-seeded the cookie unless `skipPreSeedSessionCookie: true`.
  const handle = await installMockApi(page, opts);
  await page.goto(landing);
  return handle;
}
