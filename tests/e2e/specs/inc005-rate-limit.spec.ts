/**
 * INC-005 (GitHub issue #8) — REGRESSION: over-aggressive rate limit. Normal
 * navigation / hard-refresh must NOT trip `429 RATE_LIMITED` across routine
 * authed reads, while the 5/60s brute-force cap on login/callback (INC-003) is
 * PRESERVED.
 *
 * This is the durable, live-gated inverse of the debugger's pre-fix repro
 * (`incidents/INC-005/repro/*`), which observed `GET /v1/projects` 429-ing at
 * the 5th request on a clean window and ordinary navigation producing organic
 * 429s across multiple endpoints. It reuses the hardened live `signInAs()`
 * helper and the per-response instrumentation pattern from
 * `auth-me-throttle.spec.ts` (INC-003).
 *
 * Root cause (confirmed in ROOT_CAUSE.md): in `@nestjs/throttler@6.5.0` every
 * named bucket in `forRoot` is enforced on EVERY route, so the smallest
 * (`auth` 5/60s) capped all reads. Fix A1 made `auth`/`chatbot` opt-IN (only
 * login/callback get 5/60s, only chatbot gets 30/60s); Fix B added a
 * per-principal `global` bucket (1000/60s, keyed `user:<id>` for authed reqs,
 * `ip:<addr>` otherwise) as the only app-wide read limit. The read-429 (when it
 * eventually fires at >1000/60s) carries `Retry-After-global`; the login-429
 * carries `Retry-After-auth`. CORS now exposes both.
 *
 * What this file PROVES live (per the verification scope):
 *
 *   Criterion 1(a) — EXACT reported repro: a real Alice session navigates
 *     across /timesheets, /dashboard, /leave, /schedule and HARD-REFRESHES
 *     several times within one 60s window. Capture every `/v1/*` response.
 *     Pre-fix: a burst of 429 RATE_LIMITED across multiple endpoints starting
 *     ~5th request. EXPECT: ZERO 429 RATE_LIMITED on routine reads.
 *
 *   Criterion 1(b) — AGGRAVATED probe: fire a rapid burst of ~80 sequential
 *     `GET /v1/time-entries/running` from the authed browser context. Pre-fix
 *     the 5th 429'd (the 5/60s `auth` cap). EXPECT: all 200 (well within the
 *     1000/60s per-user budget) — definitive proof the 5/60s auth cap no longer
 *     applies to reads. Plus a light per-principal sanity check: Bob (separate
 *     context) also reads fine. (The 1000-request boundary itself is unit-proven
 *     in apps/api/test/unit/principal-throttler-guard.test.ts — we do NOT
 *     attempt to exhaust it live.)
 *
 *   Criterion 3 — auth brute-force PRESERVED: 6 rapid unauthenticated
 *     `POST /v1/auth/oidc/login` (IP-keyed) → the 6th returns 429 carrying
 *     `Retry-After-auth`. Proves INC-003's protection survived Fix A1.
 *
 * Criteria 2 (per-principal independence boundary) and 4 (transient-429
 * recovery) are covered by hermetic/unit tests and are NOT brute-forced live
 * (each would need to exhaust a 1000-request budget):
 *   - apps/api/test/unit/principal-throttler-guard.test.ts (getTracker keying)
 *   - apps/web/__tests__/inc005-query-429-backoff.test.ts (429 backoff/recover)
 *
 * Run (against the already-running live stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     specs/inc005-rate-limit.spec.ts --project=chromium-live
 */
import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Whole-file gate: live-only — needs a real Keycloak handshake + the real
// backend throttler. The hermetic project skips this file cleanly.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend throttler');

// Criterion 1's tests perform a full real login (spends the 5/60s `auth`
// budget on oidc/login + oidc/callback), and criterion 3 deliberately
// exhausts the IP-keyed `auth` budget. Run serially and pace one
// auth-spending action per 60s window so they do not poison each other with
// 429s on the LOGIN endpoints (which is correct product behaviour, not the
// bug under test). Routine authed READS are now 1000/60s PER USER, so the
// in-test nav/burst does not contend for the auth budget.
test.describe.configure({ mode: 'serial' });

// The brute-force `auth` bucket is a 60s fixed window. Anchor inter-test pacing
// on that documented TTL (per oidc-flow.spec.ts / auth-me-throttle.spec.ts)
// rather than polling any endpoint (which would burn the very budget we are
// waiting to recover).
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

interface V1Hit {
  t: number;
  method: string;
  path: string;
  status: number;
  code: string | null;
  retryAfterGlobal: string | null;
  retryAfterAuth: string | null;
}

/**
 * Attach a `/v1/*` response listener to a page, recording method/path/status
 * plus the throttler `Retry-After-*` headers and the error envelope `code`
 * (so we can distinguish a 429 RATE_LIMITED from any other status). `t0` aligns
 * timestamps with a known origin.
 *
 * We read the body `code` lazily/best-effort: for a 429 the body is small JSON
 * (`{code:"RATE_LIMITED"}`); for a 200 we do not need it, so we only parse the
 * body of 429s to avoid consuming streaming/large responses.
 */
function instrumentV1(page: Page, t0: number, hits: V1Hit[]): void {
  page.on('response', (r) => {
    const u = r.url();
    const m = /\/v1\/[^?#]*/.exec(u);
    if (!m) return;
    const status = r.status();
    const headers = r.headers();
    const rec: V1Hit = {
      t: Date.now() - t0,
      method: r.request().method(),
      path: m[0],
      status,
      code: null,
      retryAfterGlobal: headers['retry-after-global'] ?? null,
      retryAfterAuth: headers['retry-after-auth'] ?? null,
    };
    hits.push(rec);
    // Only inspect the body of 429s (to confirm it is RATE_LIMITED). Wrapped in
    // a promise-catch so a body read on an already-consumed/streamed response
    // never rejects the test.
    if (status === 429) {
      r.json()
        .then((b: { code?: string }) => {
          rec.code = b?.code ?? null;
        })
        .catch(() => {
          /* body unavailable — leave code null */
        });
    }
  });
}

function rateLimited(hits: V1Hit[]): V1Hit[] {
  return hits.filter((h) => h.status === 429);
}

function logTimeline(label: string, hits: V1Hit[]): void {
  const byPath = new Map<string, { total: number; c429: number }>();
  for (const h of hits) {
    const key = `${h.method} ${h.path}`;
    const e = byPath.get(key) ?? { total: 0, c429: 0 };
    e.total += 1;
    if (h.status === 429) e.c429 += 1;
    byPath.set(key, e);
  }
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====`);
  // eslint-disable-next-line no-console
  console.log(
    `total /v1 responses: ${hits.length}  |  429s: ${rateLimited(hits).length}  ` +
      `|  window: ${(hits.length ? hits[hits.length - 1].t / 1000 : 0).toFixed(1)}s`,
  );
  // eslint-disable-next-line no-console
  console.log('--- per-endpoint (method path : total, 429s) ---');
  for (const [k, v] of [...byPath.entries()].sort()) {
    // eslint-disable-next-line no-console
    console.log(`  ${k} : ${v.total} (${v.c429}×429)`);
  }
  const c429 = rateLimited(hits);
  if (c429.length) {
    // eslint-disable-next-line no-console
    console.log('--- 429 detail (t_ms : method path : code : Retry-After-*) ---');
    for (const h of c429) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(h.t).padStart(6)}ms : ${h.method} ${h.path} : ${h.code ?? '?'}` +
          (h.retryAfterGlobal ? ` : Retry-After-global=${h.retryAfterGlobal}` : '') +
          (h.retryAfterAuth ? ` : Retry-After-auth=${h.retryAfterAuth}` : ''),
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log('===============================================\n');
}

test.describe('INC-005 — over-aggressive rate limit regression (live)', () => {
  // Pace each test against the live auth throttle before it spends budget.
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + 5_000);
    await waitForAuthWindow();
  });
  test.afterEach(() => {
    markAuthBudgetSpent();
  });

  // ---------------------------------------------------------------------------
  // CRITERION 1(a) — EXACT reported repro: navigate + hard-refresh across pages
  // inside one 60s window → ZERO 429 RATE_LIMITED on routine reads, all panels
  // load. Direct inverse of the pre-fix "many panels 429" symptom.
  // ---------------------------------------------------------------------------
  test(
    'Criterion 1(a): navigate + hard-refresh across pages fires ZERO 429 on routine reads',
    async ({ page }) => {
      const hits: V1Hit[] = [];
      // t0 BEFORE sign-in so we capture every /v1 from the first call.
      const t0 = Date.now();
      instrumentV1(page, t0, hits);

      // Real Keycloak handshake as Alice (manager).
      await signInAs(page, { actorKey: 'alice' });
      await expect(page).toHaveURL(/\/timesheets/);

      // Prove the shell RENDERED (not the spinner, not the error boundary).
      await expect(
        page.getByRole('link', { name: 'Timesheets', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();

      // Mark the boundary: reads spent during sign-in vs. during the nav probe.
      const v1AfterSignIn = hits.length;

      // --- Realistic navigate sequence, all inside ONE 60s window. Alice is a
      // manager, so /dashboard ("Team") and /schedule are reachable. Each step
      // waits on a CONCRETE rendered condition (the Sign out shell control) —
      // never an arbitrary delay — and confirms we stayed on the authed shell. ---
      const visitAndConfirmShell = async (path: string) => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
        await expect(page).not.toHaveURL(/\/login(\?|$)/);
      };

      // Client-side navigations across several pages (each fans out 4-6 reads).
      await visitAndConfirmShell('/dashboard');
      await visitAndConfirmShell('/leave');
      await visitAndConfirmShell('/schedule');
      await visitAndConfirmShell('/timesheets');

      // Hard refreshes (full document reload → React tree remount → full read
      // fan-out each time). This is the exact action that, pre-fix, fanned out
      // into the burst. Five reloads, each confirming the shell re-renders.
      for (let i = 0; i < 5; i++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
          page.getByRole('button', { name: /sign out/i }),
          `shell rendered after hard-refresh #${i + 1}`,
        ).toBeVisible();
        await expect(page).not.toHaveURL(/\/login(\?|$)/);
      }

      // Let any trailing in-flight read settle on a concrete condition.
      await expect(page.getByText('Loading Harvoost')).toHaveCount(0);

      logTimeline('INC-005 CRITERION 1(a) RESULT (live)', hits);

      const c429 = rateLimited(hits);
      const probeReads = hits.length - v1AfterSignIn;

      // --- ASSERTIONS ---
      // (1) ZERO 429 RATE_LIMITED across the WHOLE authenticated sequence. This
      //     is the headline inverse of the repro. One 429 here would mean the
      //     5/60s `auth` bucket is back on reads (or the global budget is far
      //     too small). We assert zero across all /v1 reads — incl. sign-in.
      expect(
        c429.length,
        `routine authed reads must NEVER 429 (saw ${c429.length}: ` +
          `${c429.map((h) => `${h.method} ${h.path}#${h.status}/${h.code ?? '?'}`).join(', ')})`,
      ).toBe(0);

      // (2) The probe actually drove a meaningful number of reads (otherwise the
      //     test is vacuous). 4 navigations + 5 reloads at 4-6 reads each is well
      //     above the pre-fix 5-token budget — proving we *would* have tripped it.
      expect(
        probeReads,
        `the nav/refresh probe must fire many reads (saw ${probeReads}); ` +
          `pre-fix budget was 5/60s, so this volume proves the cap is gone`,
      ).toBeGreaterThan(20);

      // (3) Final landing is the authed shell, not the spinner, not /login.
      await expect(page).toHaveURL(/\/timesheets/);
    },
  );

  // ---------------------------------------------------------------------------
  // CRITERION 1(b) — AGGRAVATED probe: a rapid burst of a single routine read.
  // Pre-fix the 5th 429'd. EXPECT all 200 (within the 1000/60s per-user budget).
  // Plus a light per-principal sanity check (Bob, separate context, reads fine).
  // ---------------------------------------------------------------------------
  test(
    'Criterion 1(b): ~80 sequential GET /v1/time-entries/running all 200 (5/60s cap gone); Bob independent',
    async ({ page, browser }) => {
      const hits: V1Hit[] = [];
      const t0 = Date.now();
      instrumentV1(page, t0, hits);

      await signInAs(page, { actorKey: 'alice' });
      await expect(page).toHaveURL(/\/timesheets/);
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();

      // Fire a tight burst of a single routine read FROM THE AUTHED BROWSER
      // CONTEXT (credentials:'include' carries the HttpOnly session cookie, so
      // these are keyed `user:<alice-id>`). 80 is far past the old 5/60s `auth`
      // cap yet comfortably under the 1000/60s per-user budget — so if the auth
      // cap still bit reads, ~75 of these would be 429.
      const BURST = 80;
      const burst = await page.evaluate(
        async ({ apiBase, n }) => {
          const out: Array<{ i: number; status: number; code: string | null }> = [];
          for (let i = 1; i <= n; i++) {
            const r = await fetch(`${apiBase}/v1/time-entries/running`, {
              credentials: 'include',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            let code: string | null = null;
            if (r.status === 429) {
              try {
                code = (await r.json())?.code ?? null;
              } catch {
                /* ignore */
              }
            }
            out.push({ i, status: r.status, code });
          }
          return out;
        },
        { apiBase, n: BURST },
      );

      const burst200 = burst.filter((b) => b.status === 200).length;
      const burst429 = burst.filter((b) => b.status === 429);
      const firstNon200 = burst.find((b) => b.status !== 200);

      // eslint-disable-next-line no-console
      console.log('\n===== INC-005 CRITERION 1(b) RESULT (live) — Alice burst =====');
      // eslint-disable-next-line no-console
      console.log(
        `GET /v1/time-entries/running ×${BURST}: 200s=${burst200}, 429s=${burst429.length}` +
          (firstNon200 ? `, first non-200 at #${firstNon200.i} (${firstNon200.status})` : ''),
      );
      // eslint-disable-next-line no-console
      console.log('==============================================================\n');

      // --- ASSERTIONS (Alice burst) ---
      // (1) Every single read is a 200. Pre-fix, #5 onward would be 429
      //     RATE_LIMITED. This is the definitive proof the 5/60s auth cap no
      //     longer applies to reads.
      expect(
        burst429.length,
        `aggravated burst must produce ZERO 429 (saw ${burst429.length}; ` +
          `first non-200 ${firstNon200 ? `at #${firstNon200.i}/${firstNon200.status}` : 'none'})`,
      ).toBe(0);
      expect(burst200, `all ${BURST} reads must be 200`).toBe(BURST);

      // --- Light per-principal sanity check: Bob in a SEPARATE context (same
      // host/IP) reads fine. NOTE: this is a sanity check, NOT a boundary proof.
      // The per-principal independence boundary (one user exhausting 1000 does
      // not starve another) is unit-proven in
      // apps/api/test/unit/principal-throttler-guard.test.ts (getTracker returns
      // `user:<id>` vs `ip:<addr>`). We do NOT attempt to exhaust the budget. ---
      // Bob's sign-in spends the `auth` bucket; but oidc/login+callback are
      // IP-keyed for the unauth pre-cookie leg. Alice's sign-in above already
      // spent ~2 of the 5 IP slots this window, so Bob's handshake (which also
      // needs ~2) still fits within 5/60s for a single shared IP. Keep Bob's
      // own reads modest (no burst) so we do not risk the shared-IP auth window.
      const bobContext: BrowserContext = await browser.newContext();
      const bobPage = await bobContext.newPage();
      let bobReads200 = 0;
      let bobReads429 = 0;
      try {
        await signInAs(bobPage, { actorKey: 'bob' });
        await expect(bobPage).toHaveURL(/\/timesheets/);
        await expect(bobPage.getByRole('button', { name: /sign out/i })).toBeVisible();

        const bobBurst = await bobPage.evaluate(
          async ({ apiBase, n }) => {
            const out: number[] = [];
            for (let i = 1; i <= n; i++) {
              const r = await fetch(`${apiBase}/v1/time-entries/running`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
              });
              out.push(r.status);
            }
            return out;
          },
          { apiBase, n: 50 },
        );
        bobReads200 = bobBurst.filter((s) => s === 200).length;
        bobReads429 = bobBurst.filter((s) => s === 429).length;

        // eslint-disable-next-line no-console
        console.log('\n===== INC-005 CRITERION 1(b) — Bob (separate context) =====');
        // eslint-disable-next-line no-console
        console.log(
          `GET /v1/time-entries/running ×50: 200s=${bobReads200}, 429s=${bobReads429}`,
        );
        // eslint-disable-next-line no-console
        console.log('===========================================================\n');

        // Bob reads fine and is NOT starved by Alice's earlier burst — a light
        // per-principal sanity check (NOT the full boundary, which is
        // unit-proven). All of Bob's modest reads are 200.
        expect(
          bobReads429,
          `Bob (separate principal) must not be starved by Alice's burst (saw ${bobReads429}×429)`,
        ).toBe(0);
        expect(bobReads200, 'all of Bob\'s reads are 200').toBe(50);
      } finally {
        await bobContext.close();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // CRITERION 3 — auth brute-force PRESERVED. 6 rapid unauthenticated
  // POST /v1/auth/oidc/login (IP-keyed) → the 6th returns 429 carrying
  // `Retry-After-auth`. Proves INC-003's protection survived Fix A1. Run LAST
  // so exhausting the IP-keyed auth bucket does not poison the sign-in handshakes
  // above. The beforeEach auth-window wait ensures the bucket is fresh here.
  // ---------------------------------------------------------------------------
  test(
    'Criterion 3: 6 rapid POST /v1/auth/oidc/login — the 6th is 429 with Retry-After-auth (brute-force preserved)',
    async ({ page }) => {
      // A fresh page starts on about:blank, from which a fetch() to the API
      // origin throws (no document origin). Land on a real app-origin document
      // first so the browser-context fetch behaves exactly as a real user's
      // (and the CORS allow-origin matches localhost:3000). We do NOT sign in —
      // these are deliberately UNAUTHENTICATED, IP-keyed POSTs.
      await page.goto('/login');

      const results = await page.evaluate(
        async ({ apiBase }) => {
          const outcomes: Array<{
            attempt: number;
            status: number;
            code: string | null;
            retryAfterAuth: string | null;
          }> = [];
          for (let i = 1; i <= 6; i++) {
            const r = await fetch(`${apiBase}/v1/auth/oidc/login`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: JSON.stringify({}),
            });
            let code: string | null = null;
            try {
              code = (await r.json())?.code ?? null;
            } catch {
              /* non-JSON or empty body */
            }
            outcomes.push({
              attempt: i,
              status: r.status,
              code,
              // CORS now exposes Retry-After-auth, so the browser fetch can read it.
              retryAfterAuth: r.headers.get('retry-after-auth'),
            });
          }
          return outcomes;
        },
        { apiBase },
      );

      // eslint-disable-next-line no-console
      console.log('\n===== INC-005 CRITERION 3 RESULT (live) — auth brute-force =====');
      for (const o of results) {
        // eslint-disable-next-line no-console
        console.log(
          `  attempt ${o.attempt}: ${o.status}` +
            (o.code ? ` ${o.code}` : '') +
            (o.retryAfterAuth ? ` (Retry-After-auth=${o.retryAfterAuth})` : ''),
        );
      }
      // eslint-disable-next-line no-console
      console.log('================================================================\n');

      // --- ASSERTIONS ---
      // (1) Attempts 1-5 succeed (201 Created — the login-init handler mints a
      //     state + returns the authorization_url). The exact 2xx is not the
      //     point; the point is they are NOT throttled.
      for (let i = 0; i < 5; i++) {
        expect(
          results[i]!.status,
          `login-init attempt ${results[i]!.attempt} must NOT be throttled`,
        ).toBeLessThan(400);
      }

      // (2) Attempt 6 is throttled: 429 RATE_LIMITED — the 5/60s `auth` bucket
      //     on login/callback is intact (INC-003 brute-force protection survived
      //     Fix A1 making auth opt-in).
      expect(results[5]!.status, 'the 6th login-init POST must be 429').toBe(429);
      expect(results[5]!.code, 'the throttled login envelope is RATE_LIMITED').toBe(
        'RATE_LIMITED',
      );

      // (3) The throttled login-429 carries `Retry-After-auth` (the bucket that
      //     blocked is `auth`), and CORS exposes it so the browser can read it.
      expect(
        results[5]!.retryAfterAuth,
        'the auth-bucket 429 must carry a CORS-exposed Retry-After-auth header',
      ).toBeTruthy();
    },
  );
});
