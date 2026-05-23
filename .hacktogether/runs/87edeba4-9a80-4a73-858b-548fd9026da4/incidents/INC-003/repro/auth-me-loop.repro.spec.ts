/**
 * THROWAWAY REPRO — INC-003 (GitHub issue #3).
 * Reproduces the authenticated GET /v1/auth/me request-storm that trips the
 * 5/60s "auth" throttle bucket and renders the app unusable.
 *
 * Confirms TWO compounding defects with LIVE evidence:
 *   B (trigger):  authenticated /me + login + callback all share the 5/60s
 *                 brute-force "auth" bucket (auth.controller.ts:56 class-level
 *                 @Throttle covers @Get('me') line 334; app.module.ts:40 auth=5/60s).
 *                 A real session 429s on /me within seconds.
 *   A (amplifier):useCurrentUser (auth.ts:28-31) maps only 401/403 -> null and
 *                 RE-THROWS 429 (-> query error, data === undefined); page.tsx:14-18
 *                 redirects to /login on any falsy user -> remount -> refetch with
 *                 retry:false (auth.ts:35) and NO backoff -> a /me storm + login loop.
 *
 * This spec attaches network listeners BEFORE sign-in and drives the Keycloak
 * login by hand (it does NOT use the shared signInAs() waitForURL, which throws
 * when the app bounces back to /login — that bounce is the bug we are capturing).
 *
 * Run (against the already-running live stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     --config ../../.hacktogether/runs/<run>/incidents/INC-003/repro/playwright.repro.config.ts
 */
import { test, expect } from '@playwright/test';

interface Hit {
  t: number;
  status: number;
  retryAfter: string | null;
}

test.use({ baseURL: 'http://localhost:3000' });
test.setTimeout(120_000);

const ALICE_EMAIL = 'alice@harvoost.local';
const ALICE_PASS = 'dev-alice-pass';

test('INC-003: authenticated /me storm trips RATE_LIMITED and redirects to /login', async ({ page }) => {
  const t0 = Date.now();
  const meHits: Hit[] = [];
  const authPostHits: Array<{ t: number; status: number; path: string }> = [];
  const navs: Array<{ t: number; url: string }> = [];

  page.on('response', (r) => {
    const u = r.url();
    if (/\/v1\/auth\/me(\?|$)/.test(u)) {
      meHits.push({
        t: Date.now() - t0,
        status: r.status(),
        retryAfter: r.headers()['retry-after'] ?? null,
      });
    } else if (/\/v1\/auth\/oidc\/(login|callback)(\?|$)/.test(u)) {
      authPostHits.push({ t: Date.now() - t0, status: r.status(), path: new URL(u).pathname });
    }
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navs.push({ t: Date.now() - t0, url: f.url() });
  });

  // --- 1. Drive the real Keycloak sign-in as Alice by hand. ---
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /continue with .+/i }).click();
  await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/, { timeout: 20_000 });
  await page.getByRole('textbox', { name: /email|username/i }).fill(ALICE_EMAIL);
  await page.locator('#password').fill(ALICE_PASS);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  // Wait for the post-callback resolution: either /timesheets (success) OR /login (the bug).
  await page.waitForURL(/\/(timesheets|login)(\?|$)/, { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(2500); // let any immediate refetch fan-out settle
  console.log('\n[after sign-in] url =', page.url(), ' meHits =', meHits.length);

  // --- 2. If we DID land authenticated, drive hard refreshes to trip the bucket. ---
  // (If we already bounced to /login, the storm has already begun — keep observing.)
  for (let i = 0; i < 10; i++) {
    const last = meHits[meHits.length - 1];
    if (last && last.status === 429) {
      await page.waitForTimeout(3000); // capture the amplifier storm
      break;
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(700);
    console.log(
      `[reload ${i + 1}] url=${page.url().replace('http://localhost:3000', '')} ` +
        `meHits=${meHits.length} last=${meHits[meHits.length - 1]?.status ?? 'n/a'}`,
    );
  }

  // --- 3. Report. ---
  const statuses = meHits.map((h) => h.status);
  const first429Index = statuses.indexOf(429);
  const total429 = statuses.filter((s) => s === 429).length;
  const ok200 = statuses.filter((s) => s === 200).length;
  const windowSec = meHits.length ? (meHits[meHits.length - 1].t / 1000).toFixed(1) : '0';
  const loginNavs = navs.filter((n) => /\/login(\?|$)/.test(n.url));

  console.log('\n===== INC-003 REPRO RESULT =====');
  console.log(`total /me requests: ${meHits.length} over ${windowSec}s  (200s=${ok200}, 429s=${total429})`);
  console.log(`/me statuses in order: [${statuses.join(', ')}]`);
  console.log(`first 429 at /me request #: ${first429Index === -1 ? 'NONE' : first429Index + 1}`);
  console.log(`auth login/callback POSTs: ${JSON.stringify(authPostHits)}`);
  console.log(`navigations to /login: ${loginNavs.length}`);
  console.log('--- /me timeline (t_ms : status : retry-after) ---');
  for (const h of meHits) console.log(`  ${String(h.t).padStart(6)}ms : ${h.status}${h.retryAfter ? ' : Retry-After=' + h.retryAfter : ''}`);
  console.log('--- main-frame navigations ---');
  for (const n of navs) console.log(`  ${String(n.t).padStart(6)}ms : ${n.url.replace('http://localhost:3000', '')}`);
  const finalBody = (await page.locator('body').innerText().catch(() => '(no body)')).slice(0, 400);
  console.log('--- final landing body text ---\n', JSON.stringify(finalBody));
  console.log('================================\n');

  expect(total429, 'expected at least one 429 RATE_LIMITED on authenticated /me').toBeGreaterThan(0);
});
