/**
 * INC-003 (GitHub issue #3) — REGRESSION: authenticated `GET /v1/auth/me` must
 * not trip the brute-force throttle, and a transient 429 on `/me` must back off
 * + recover instead of stampeding into a /login redirect storm.
 *
 * This is the durable, live-gated inverse of the debugger's pre-fix repro
 * (`incidents/INC-003/repro/auth-me-loop.repro.spec.ts`, which observed 909 `/me`
 * requests in 11.4s — 4×200 then 905×429 — and a spinner-wedged app). It reuses
 * that repro's instrumentation (per-`/me` status/Retry-After counting, main-frame
 * navigation tracking) and the hardened live `signInAs()` helper.
 *
 * Two compounding defects were fixed; this spec proves both are dead LIVE:
 *   B (trigger):   `GET /v1/auth/me` was on the 5/60s `auth` brute-force bucket
 *                  shared with oidc/login + oidc/callback. Fix: `@SkipThrottle({
 *                  auth: true })` on `me()` → `/me` uses the global 300/60s bucket.
 *   A (amplifier): `useCurrentUser` treated 429/5xx/network as "logged out" →
 *                  redirect → remount → refetch storm. Fix: 429/5xx/network are
 *                  TRANSIENT (data stays `undefined`, never `null`); redirect only
 *                  on `data === null`; bounded exponential backoff honoring
 *                  `Retry-After-auth`.
 *
 * Criterion 1 (this file, test 1): a REAL authenticated Alice session navigates
 *   across pages and hard-refreshes repeatedly inside one 60s window → ASSERT
 *   zero 429 on `/me`, bounded request count (dozens, not a storm), app stays on
 *   the rendered shell (never wedged on "Loading Harvoost", never bounced to
 *   /login). Exercises the BACKEND fix (defect B) end-to-end.
 *
 * Criterion 2 (this file, test 2): with a real session, force `/me` to return
 *   429 (body RATE_LIMITED, header `Retry-After-auth: 2`) via route interception,
 *   trigger a refetch → ASSERT the app does NOT navigate to /login and does NOT
 *   emit a burst of `/me` (single-digit bounded retries with backoff). Then LIFT
 *   the intercept → ASSERT the authenticated shell recovers without a reload-loop.
 *   Exercises the FRONTEND fix (defect A) even when a 429 does occur.
 *
 * Run (against the already-running live stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     specs/auth-me-throttle.spec.ts --project=chromium-live
 */
import { expect, test, type Page } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

// Whole-file gate: live-only — needs a real Keycloak handshake + real backend
// throttler. The hermetic project skips this file cleanly.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend throttler');

// Both tests perform a full real login, which spends auth-throttle budget
// (oidc/login + oidc/callback are still on the 5/60s bucket — correctly). Run
// serially and pace one-login-per-window so the two logins do not poison each
// other with 429s on the LOGIN endpoints (which is correct product behaviour,
// not the bug under test). The `/me` calls themselves no longer touch the auth
// bucket, so they do not contend for budget.
test.describe.configure({ mode: 'serial' });

// The brute-force `auth` bucket is a 60s fixed window. Anchor inter-test pacing
// on that documented TTL (per oidc-flow.spec.ts) rather than polling any
// endpoint (which would burn the very budget we are waiting to recover).
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

interface MeHit {
  t: number;
  status: number;
  retryAfterAuth: string | null;
}

interface Nav {
  t: number;
  url: string;
}

/**
 * Attach `/me` response + main-frame navigation listeners to a page, recording
 * into the provided arrays. Mirrors the repro's instrumentation. `t0` lets the
 * caller align timestamps with a known origin (e.g. just-after-sign-in).
 */
function instrument(page: Page, t0: number, meHits: MeHit[], navs: Nav[]): void {
  page.on('response', (r) => {
    const u = r.url();
    if (/\/v1\/auth\/me(\?|$)/.test(u)) {
      meHits.push({
        t: Date.now() - t0,
        status: r.status(),
        // The named-bucket NestJS throttler emits `Retry-After-auth` (seconds),
        // not a plain `Retry-After` (confirmed live in ROOT_CAUSE.md).
        retryAfterAuth: r.headers()['retry-after-auth'] ?? null,
      });
    }
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navs.push({ t: Date.now() - t0, url: f.url() });
  });
}

function summarise(meHits: MeHit[]): {
  statuses: number[];
  ok200: number;
  c429: number;
  other: number;
  windowSec: string;
} {
  const statuses = meHits.map((h) => h.status);
  return {
    statuses,
    ok200: statuses.filter((s) => s === 200).length,
    c429: statuses.filter((s) => s === 429).length,
    other: statuses.filter((s) => s !== 200 && s !== 429).length,
    windowSec: meHits.length ? (meHits[meHits.length - 1].t / 1000).toFixed(1) : '0',
  };
}

test.describe('INC-003 — authenticated /me throttle regression (live)', () => {
  // Pace each test against the live auth throttle: wait a full window since the
  // previous test's login activity before spending budget on a new login. The
  // pre-wait is added on top of the test timeout so it does not eat the budget.
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + 5_000);
    await waitForAuthWindow();
  });
  test.afterEach(() => {
    markAuthBudgetSpent();
  });

  // ---------------------------------------------------------------------------
  // CRITERION 1 — real authenticated session navigates + hard-refreshes without
  // tripping RATE_LIMITED. Direct inverse of the 905×-429 repro.
  // ---------------------------------------------------------------------------
  test(
    'Criterion 1: authenticated navigation + hard-refresh fires zero 429 on /me and never wedges',
    async ({ page }) => {
      const meHits: MeHit[] = [];
      const navs: Nav[] = [];
      // t0 BEFORE sign-in so we capture every /me from the very first call.
      const t0 = Date.now();
      instrument(page, t0, meHits, navs);

      // Real Keycloak handshake as Alice (manager). The hardened live helper
      // waits for the post-callback landing on an authed route.
      await signInAs(page, { actorKey: 'alice' });
      await expect(page).toHaveURL(/\/timesheets/);

      const meAfterSignIn = meHits.length;
      // The sign-in flow LEGITIMATELY visits /login as its entry point
      // (/login → [IdP button] → Keycloak → /auth/callback → /timesheets). Those
      // entry-path /login navigations are expected and are NOT the bug. The bug
      // is a POST-authentication BOUNCE back to /login. Mark the navigation
      // timeline boundary at the moment we are confirmed authenticated, so the
      // /login-bounce assertion only considers navigations AFTER sign-in settled.
      const navsAtAuth = navs.length;

      // Prove the shell RENDERED (not the spinner, not the error boundary). The
      // Timesheets sidebar nav link + Sign out control exist only on the real
      // shell. `exact: true` disambiguates the sidebar link from the empty-state
      // body link (both href=/timesheets).
      await expect(
        page.getByRole('link', { name: 'Timesheets', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();

      // --- Drive a realistic navigate/refresh sequence, all inside ONE 60s
      // window. Alice is a manager, so /dashboard ("Team") is reachable. ---
      // Each step waits on a CONCRETE rendered condition (a shell nav element /
      // the spinner being gone) — never an arbitrary delay.
      const visitAndConfirmShell = async (path: string) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        // The sidebar nav (Sign out control) is present on every authed shell
        // regardless of route — a stable "we are on the authed shell, not the
        // spinner, not /login" marker.
        await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
        await expect(page).not.toHaveURL(/\/login(\?|$)/);
      };

      // Client-side navigations across several pages.
      await visitAndConfirmShell('/dashboard');
      await visitAndConfirmShell('/timesheets');
      await visitAndConfirmShell('/leave');
      await visitAndConfirmShell('/timesheets');

      // Hard refreshes (full document reloads → React tree remount → /me refetch
      // each time). This is the exact action that, pre-fix, fanned out into the
      // storm. Five reloads, each confirming the shell re-renders.
      for (let i = 0; i < 5; i++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
          page.getByRole('button', { name: /sign out/i }),
          `shell rendered after hard-refresh #${i + 1}`,
        ).toBeVisible();
        await expect(page).not.toHaveURL(/\/login(\?|$)/);
      }

      // Let any trailing in-flight /me settle on a concrete condition (the
      // spinner label must be gone — i.e. the auth gate has resolved), rather
      // than a fixed sleep.
      await expect(page.getByText('Loading Harvoost')).toHaveCount(0);

      // --- Report (mirrors the repro's output for an apples-to-apples diff). ---
      const s = summarise(meHits);
      // ALL /login navigations (incl. the legitimate sign-in entry) — for the log.
      const allLoginNavs = navs.filter((n) => /\/login(\?|$)/.test(n.url));
      // POST-AUTH /login navigations only — the actual "bounce" symptom of the bug.
      const postAuthLoginNavs = navs
        .slice(navsAtAuth)
        .filter((n) => /\/login(\?|$)/.test(n.url));
      // eslint-disable-next-line no-console
      console.log('\n===== INC-003 CRITERION 1 RESULT (live) =====');
      // eslint-disable-next-line no-console
      console.log(
        `total /me requests: ${meHits.length} over ${s.windowSec}s  ` +
          `(200s=${s.ok200}, 429s=${s.c429}, other=${s.other}); ` +
          `${meAfterSignIn} during sign-in`,
      );
      // eslint-disable-next-line no-console
      console.log(`/me statuses in order: [${s.statuses.join(', ')}]`);
      // eslint-disable-next-line no-console
      console.log(
        `navigations to /login: ${allLoginNavs.length} total ` +
          `(${postAuthLoginNavs.length} POST-auth bounces — the bug symptom)`,
      );
      // eslint-disable-next-line no-console
      console.log('--- /me timeline (t_ms : status[: Retry-After-auth]) ---');
      for (const h of meHits) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${String(h.t).padStart(6)}ms : ${h.status}` +
            (h.retryAfterAuth ? ` : Retry-After-auth=${h.retryAfterAuth}` : ''),
        );
      }
      // eslint-disable-next-line no-console
      console.log('=============================================\n');

      // --- ASSERTIONS ---
      // (1) ZERO 429 on /me across the whole authenticated sequence. This is the
      //     core inverse of the repro (which saw 905). One 429 would mean defect
      //     B (the bucket) is back.
      expect(s.c429, 'authenticated /me must NEVER return 429 (defect B fixed)').toBe(0);

      // (2) Every observed /me is a clean 200 (the authed guard passes and the
      //     throttler does not bite). No 5xx, no surprise statuses.
      expect(s.other, 'no unexpected /me statuses (only 200s expected)').toBe(0);
      expect(s.ok200, 'at least one successful /me (the session is real)').toBeGreaterThan(0);

      // (3) Request count is SMALL and bounded — dozens at most, NOT a storm. We
      //     drove ~1 sign-in + 4 client navs + 5 hard refreshes ≈ 10-ish remounts.
      //     The repro saw 909. A generous ceiling of 60 still screams "no storm"
      //     while tolerating React-Query refetch-on-mount and a couple of retries.
      expect(
        meHits.length,
        `bounded /me count (no storm) — saw ${meHits.length}, repro saw 909`,
      ).toBeLessThan(60);

      // (4) The app NEVER bounced BACK to /login after authentication (the
      //     visible symptom of defect A). The sign-in entry visit to /login is
      //     expected and excluded via the navsAtAuth boundary.
      expect(
        postAuthLoginNavs.length,
        'authenticated session must never bounce back to /login after sign-in',
      ).toBe(0);

      // (5) Final landing is the authed shell, not the spinner, not /login.
      await expect(page).toHaveURL(/\/timesheets/);
    },
  );

  // ---------------------------------------------------------------------------
  // CRITERION 2 — a forced 429 on /me does NOT redirect to /login and does NOT
  // storm; it backs off and recovers when /me returns 200 again. Proves the
  // frontend amplifier (defect A) is dead even when a 429 DOES occur.
  // ---------------------------------------------------------------------------
  test(
    'Criterion 2: forced 429 on /me backs off (no /login redirect, no storm) then recovers',
    async ({ page }) => {
      const meHits: MeHit[] = [];
      const navs: Nav[] = [];
      const t0 = Date.now();
      instrument(page, t0, meHits, navs);

      // Sign in for real first (cookie + authed shell), with the intercept OFF so
      // the real handshake + initial /me succeed normally.
      await signInAs(page, { actorKey: 'alice' });
      await expect(page).toHaveURL(/\/timesheets/);
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();

      // Mark the boundary: everything after this index is during the forced-429
      // window (the real sign-in's /me 200s are before it).
      const beforeForce = meHits.length;
      // The sign-in flow legitimately ENTERS via /login (/login → Keycloak →
      // callback → /timesheets). Those entry navigations are expected and are
      // NOT the bug; the bug is a POST-auth bounce back to /login. Snapshot the
      // navigation index now so the /login assertions only consider what happens
      // AFTER we are authenticated (i.e. during/after the forced-429 window).
      const navsAtAuth = navs.length;

      // --- FORCE 429 on every /me. Body + header match the live throttler
      // envelope (RATE_LIMITED + Retry-After-auth), with a SMALL retry value so
      // the backoff resolves fast within the test. ---
      let forcing = true;
      await page.route('**/v1/auth/me', async (route) => {
        if (!forcing) {
          await route.continue(); // intercept lifted → real backend (real 200)
          return;
        }
        await route.fulfill({
          status: 429,
          headers: {
            'content-type': 'application/json',
            'Retry-After-auth': '2',
            // CORS: the browser fetch uses credentials:'include' against the
            // :3001 origin, so the fulfilled response must echo the allow
            // headers or the body is opaque to the app (and React Query would
            // see a network error, not a 429). The real backend sends these.
            'access-control-allow-origin': 'http://localhost:3000',
            'access-control-allow-credentials': 'true',
          },
          body: JSON.stringify({
            code: 'RATE_LIMITED',
            message: 'ThrottlerException: Too Many Requests',
          }),
        });
      });

      const forceStart = Date.now() - t0;

      // Trigger an auth refetch under the forced 429: a hard refresh remounts the
      // React tree → useCurrentUser refetches /me → now gets 429. Pre-fix this
      // mapped to "logged out" → /login → remount → storm. Post-fix it must be a
      // TRANSIENT error: stay on the spinner, back off, never redirect.
      await page.reload({ waitUntil: 'domcontentloaded' });

      // The page should sit on the "Loading Harvoost" spinner (auth gate = wait),
      // NOT navigate to /login. Assert the spinner is showing (web-first wait on
      // a concrete element) — this confirms we are in the transient state.
      await expect(
        page.getByText('Loading Harvoost'),
        'app stays on the spinner during the forced 429 (no /login bounce)',
      ).toBeVisible();

      // Observe the backoff window. We need a bounded WAIT to let any retry
      // fan-out happen — but tied to a real condition: we wait until the URL is
      // stable on the home/spinner route AND give the bounded backoff (retry
      // count < 4, delays honoring Retry-After-auth=2s ≈ a handful of attempts
      // over a few seconds) time to fire. We poll the /me count cheaply and
      // assert it never explodes. A storm (pre-fix) would add hundreds in this
      // window; bounded backoff adds single digits.
      // Wait on the documented backoff horizon: 4 retries honoring a 2s
      // Retry-After-auth ≈ up to ~8s of attempts. Watch for ~9s, asserting the
      // app never leaves for /login and the count never storms.
      const forceObserveDeadline = Date.now() + 9_000;
      while (Date.now() < forceObserveDeadline) {
        // Hard ceiling check during the window — fail fast on a storm.
        const duringForce = meHits.filter((h) => h.t >= forceStart);
        expect(
          duringForce.length,
          `no /me storm during forced-429 window — saw ${duringForce.length}`,
        ).toBeLessThan(20);
        // Must never have bounced to /login.
        expect(
          navs.some((n) => n.t >= forceStart && /\/login(\?|$)/.test(n.url)),
          'must NOT navigate to /login during the forced-429 window',
        ).toBe(false);
        await page.waitForTimeout(500);
      }

      const duringForce = meHits.filter((h) => h.t >= forceStart);
      const forced429 = duringForce.filter((h) => h.status === 429);

      // --- LIFT the intercept: /me returns the real 200 again. ---
      forcing = false;
      // Nudge a refetch so React Query re-attempts promptly rather than waiting
      // out the staleTime. A reload remounts and refetches against the now-real
      // /me. (The query may also recover on its own via the in-flight retry, but
      // an explicit reload makes recovery deterministic + fast.)
      await page.reload({ waitUntil: 'domcontentloaded' });

      // RECOVERY: the authenticated shell must render again (Sign out control
      // visible), the spinner gone, and we are NOT on /login. No reload-loop.
      await expect(
        page.getByRole('button', { name: /sign out/i }),
        'authed shell recovers once /me returns 200 again',
      ).toBeVisible();
      await expect(page.getByText('Loading Harvoost')).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/login(\?|$)/);

      const recoverHits = meHits.filter((h) => h.t > (Date.now() - t0) - 8_000);

      // --- Report. ---
      const allLoginNavs = navs.filter((n) => /\/login(\?|$)/.test(n.url));
      // POST-AUTH /login navigations only — the actual bounce symptom of defect A.
      const postAuthLoginNavs = navs
        .slice(navsAtAuth)
        .filter((n) => /\/login(\?|$)/.test(n.url));
      // eslint-disable-next-line no-console
      console.log('\n===== INC-003 CRITERION 2 RESULT (live) =====');
      // eslint-disable-next-line no-console
      console.log(`/me before forcing (real sign-in): ${beforeForce}`);
      // eslint-disable-next-line no-console
      console.log(
        `/me during forced-429 window: ${duringForce.length} ` +
          `(429s=${forced429.length}, 200s=${duringForce.filter((h) => h.status === 200).length})`,
      );
      // eslint-disable-next-line no-console
      console.log(`/me statuses during force: [${duringForce.map((h) => h.status).join(', ')}]`);
      // eslint-disable-next-line no-console
      console.log(
        `navigations to /login: ${allLoginNavs.length} total ` +
          `(${postAuthLoginNavs.length} POST-auth bounces — the bug symptom)`,
      );
      // eslint-disable-next-line no-console
      console.log(`recovered: shell visible after lifting intercept (recent /me: ${recoverHits.length})`);
      // eslint-disable-next-line no-console
      console.log('=============================================\n');

      // --- ASSERTIONS ---
      // (1) The intercept actually fired at least one 429 (otherwise the test is
      //     vacuous — we did not exercise the 429 path).
      expect(forced429.length, 'the forced intercept must produce >=1 429 on /me').toBeGreaterThan(0);

      // (2) NO post-auth /login bounce — the transient 429 must not be treated
      //     as "logged out" (the core of defect A). The sign-in entry visit to
      //     /login is expected and excluded via the navsAtAuth boundary.
      expect(
        postAuthLoginNavs.length,
        'forced 429 must NEVER bounce back to /login after auth (defect A fixed)',
      ).toBe(0);

      // (3) NO storm — bounded retries with backoff. Pre-fix this window held
      //     hundreds; post-fix it is single digits (retry count < 4 per remount).
      expect(
        duringForce.length,
        `bounded /me during forced-429 (no storm) — saw ${duringForce.length}`,
      ).toBeLessThan(20);

      // (4) Recovery: final landing is the authed shell on /timesheets (or home
      //     resolving to it), not /login, not wedged.
      await expect(page).toHaveURL(/\/(timesheets|$)/);
    },
  );
});
