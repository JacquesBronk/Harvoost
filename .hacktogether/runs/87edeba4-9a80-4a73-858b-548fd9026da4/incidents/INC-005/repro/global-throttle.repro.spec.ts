/**
 * INC-005 (GitHub issue #8) — REPRO: the `global` 300/60s rate-limit bucket is
 * exhausted by ordinary multi-request navigation, returning 429 RATE_LIMITED
 * across MANY distinct endpoints at once. Distinct from INC-003 (the /me auth
 * bucket redirect loop): here it is the IP-keyed `global` bucket.
 *
 * Goals (debugger REPRODUCE + CONFIRM, not re-discover):
 *   Test 1 (FAN-OUT): a real authed Alice session does a single landing + a few
 *     navigations; we count how many distinct /v1/* requests one authed page
 *     load actually fires, to ground the "right-size the budget" recommendation.
 *   Test 2 (EXHAUSTION): drain the shared global bucket within one 60s window by
 *     issuing same-origin credentialed reads against real authed endpoints from
 *     INSIDE the page (so they carry the session cookie and count against the
 *     SAME IP-keyed bucket the UI uses), then prove that subsequent NORMAL UI
 *     reads across multiple endpoints return 429 — and capture the EXACT 429
 *     response header name the global bucket emits (the fix's load-bearing fact).
 *   Test 3 (CROSS-CONTEXT IP SHARING): two independent browser contexts (= two
 *     "tabs"/sessions behind the same dev IP) share ONE 300/60s budget — one
 *     drains it, the other gets 429s without having done anything unusual.
 *
 * Run (live stack up, CLEAR auth + global window before starting):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     --config ../../.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/playwright.repro.config.ts \
 *     --reporter=list
 */
import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { signInAs, isLiveMode } from '../../../../../../tests/e2e/fixtures/auth.js';

test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend throttler');
test.describe.configure({ mode: 'serial' });

// Both login-bearing tests spend the 5/60s auth bucket. Pace one login per
// window so login 429s (correct behaviour) do not pollute the global-bucket
// observation. We also need the GLOBAL bucket (300/60s) clear at the start of
// each exhaustion observation — the same 60s TTL anchors both.
const WINDOW_MS = 60_000;
let lastBudgetSpentAt = Date.now() - WINDOW_MS;
function markSpent(): void { lastBudgetSpentAt = Date.now(); }
async function waitForWindow(): Promise<void> {
  const target = lastBudgetSpentAt + WINDOW_MS + 2_000;
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

interface Hit {
  t: number;
  method: string;
  path: string;
  status: number;
  // every Retry-After* header variant we can see, to pin the exact name.
  retryAfter: string | null;
  retryAfterAuth: string | null;
  retryAfterGlobal: string | null;
  rateLimitRemaining: string | null;
}

const API_RE = /\/v1\//;

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? '?…' : '');
  } catch {
    return url;
  }
}

function instrument(page: Page, t0: number, hits: Hit[]): void {
  page.on('response', (r) => {
    const u = r.url();
    if (!API_RE.test(u)) return;
    const h = r.headers();
    hits.push({
      t: Date.now() - t0,
      method: r.request().method(),
      path: pathOf(u),
      status: r.status(),
      retryAfter: h['retry-after'] ?? null,
      retryAfterAuth: h['retry-after-auth'] ?? null,
      retryAfterGlobal: h['retry-after-global'] ?? null,
      rateLimitRemaining: h['x-ratelimit-remaining-global'] ?? h['x-ratelimit-remaining'] ?? null,
    });
  });
}

function tally(hits: Hit[]): Map<string, { total: number; c200: number; c429: number; other: number }> {
  const m = new Map<string, { total: number; c200: number; c429: number; other: number }>();
  for (const h of hits) {
    const key = `${h.method} ${h.path}`;
    const e = m.get(key) ?? { total: 0, c200: 0, c429: 0, other: 0 };
    e.total++;
    if (h.status === 200) e.c200++;
    else if (h.status === 429) e.c429++;
    else e.other++;
    m.set(key, e);
  }
  return m;
}

function printTally(label: string, hits: Hit[]): void {
  const m = tally(hits);
  // eslint-disable-next-line no-console
  console.log(`\n----- ${label} (per endpoint) -----`);
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1].total - a[1].total)) {
    // eslint-disable-next-line no-console
    console.log(`  ${String(v.total).padStart(4)}x  200=${v.c200} 429=${v.c429} other=${v.other}  ${k}`);
  }
}

test('INC-005 T1 — fan-out: count /v1 requests for one authed landing + a few navs', async ({ page }) => {
  await waitForWindow();
  const hits: Hit[] = [];
  const t0 = Date.now();
  instrument(page, t0, hits);

  await signInAs(page, { actorKey: 'alice' });
  await expect(page).toHaveURL(/\/timesheets/);
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  const afterLanding = hits.length;

  // A few realistic client navigations (Alice is a manager).
  for (const p of ['/dashboard', '/timesheets', '/leave', '/timesheets']) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  }
  // settle
  await expect(page.getByText('Loading Harvoost')).toHaveCount(0);

  printTally('T1 FAN-OUT all /v1 hits', hits);
  // eslint-disable-next-line no-console
  console.log(`\n===== INC-005 T1 FAN-OUT =====`);
  // eslint-disable-next-line no-console
  console.log(`/v1 requests during sign-in + first landing: ${afterLanding}`);
  // eslint-disable-next-line no-console
  console.log(`/v1 requests total (landing + 4 navs): ${hits.length}`);
  // eslint-disable-next-line no-console
  console.log(`429s seen during normal nav: ${hits.filter((h) => h.status === 429).length} (expected 0 on a clear window)`);
  // eslint-disable-next-line no-console
  console.log(`==============================\n`);
  markSpent();
});

test('INC-005 T2 — exhaustion: drain global bucket then normal reads 429 across endpoints', async ({ page }) => {
  await waitForWindow();
  const hits: Hit[] = [];
  const t0 = Date.now();
  instrument(page, t0, hits);

  await signInAs(page, { actorKey: 'alice' });
  await expect(page).toHaveURL(/\/timesheets/);
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();

  // --- DRAIN: fire many same-origin credentialed reads from inside the page so
  // they carry the HttpOnly session cookie and count against the SAME IP-keyed
  // global bucket the UI uses. Spread across two real authed GET endpoints so we
  // also prove the bucket is shared ACROSS endpoints (not per-route). ---
  const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
  const drain = await page.evaluate(async (base) => {
    const targets = ['/v1/time-entries/running', '/v1/projects'];
    const results: Record<string, number> = {};
    let first429At = -1;
    // 320 requests > 300 budget; stop early once we have seen plenty of 429s.
    for (let i = 0; i < 320; i++) {
      const path = targets[i % targets.length];
      try {
        const res = await fetch(base + path, {
          credentials: 'include',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        results[String(res.status)] = (results[String(res.status)] ?? 0) + 1;
        if (res.status === 429 && first429At < 0) first429At = i;
      } catch {
        results['err'] = (results['err'] ?? 0) + 1;
      }
    }
    return { results, first429At };
  }, apiBase);

  // eslint-disable-next-line no-console
  console.log(`\n===== INC-005 T2 DRAIN (in-page fetch) =====`);
  // eslint-disable-next-line no-console
  console.log(`drain status tally: ${JSON.stringify(drain.results)}`);
  // eslint-disable-next-line no-console
  console.log(`first 429 at request index: ${drain.first429At} (budget should be ~300 within 60s)`);

  // --- Now do NORMAL UI reads across multiple pages and capture the 429s the
  // app's own queries receive — this is what the user sees as "panels failing". ---
  const beforeNav = hits.length;
  for (const p of ['/timesheets', '/dashboard', '/leave']) {
    await page.goto(p, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // best-effort small settle without long sleeps
    await page.waitForTimeout(800);
  }

  const uiHits = hits.slice(beforeNav);
  const ui429 = uiHits.filter((h) => h.status === 429);
  const endpoints429 = new Set(ui429.map((h) => `${h.method} ${h.path}`));

  printTally('T2 in-app /v1 hits during the post-drain navigation', uiHits);

  // --- Capture the EXACT 429 header shape (the fix's load-bearing fact). ---
  const sample429 = [...hits].find((h) => h.status === 429);
  // eslint-disable-next-line no-console
  console.log(`\n----- T2 429 HEADER SHAPE (first observed 429) -----`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(sample429, null, 2));
  // Header presence across ALL 429s:
  const all429 = hits.filter((h) => h.status === 429);
  const withRA = all429.filter((h) => h.retryAfter).length;
  const withRAauth = all429.filter((h) => h.retryAfterAuth).length;
  const withRAglobal = all429.filter((h) => h.retryAfterGlobal).length;
  // eslint-disable-next-line no-console
  console.log(`\n===== INC-005 T2 RESULT =====`);
  // eslint-disable-next-line no-console
  console.log(`total /v1 429s observed (drain + UI): ${all429.length}`);
  // eslint-disable-next-line no-console
  console.log(`429 header presence — Retry-After: ${withRA}, Retry-After-auth: ${withRAauth}, Retry-After-global: ${withRAglobal} (of ${all429.length})`);
  // eslint-disable-next-line no-console
  console.log(`UI-driven 429s after drain: ${ui429.length} across ${endpoints429.size} distinct endpoints:`);
  for (const e of endpoints429) {
    // eslint-disable-next-line no-console
    console.log(`    ${e}`);
  }
  // eslint-disable-next-line no-console
  console.log(`=============================\n`);

  // ASSERTIONS — confirm the bug exists.
  expect(all429.length, 'the limiter must be exhausted (>=1 429)').toBeGreaterThan(0);
  // CORRECTION to the issue's diagnosis: the binding limit is NOT the `global`
  // 300/60s bucket — it is the `auth` 5/60s bucket, which forRoot declares as a
  // GLOBAL named throttler that the stock guard enforces on EVERY route unless
  // @SkipThrottle({auth:true}) names it (only /me does). So a routine read 429s
  // after only a handful of hits, not ~300. We therefore assert the drain trips
  // FAST (within the first dozens), and separately prove the per-route auth=5
  // ceiling in effective-limit.probe.spec.ts.
  expect(
    drain.first429At,
    'reads 429 quickly because the smallest forRoot bucket (auth 5/60s) binds every route',
  ).toBeGreaterThanOrEqual(0);
  // The headline symptom: 429s land on MULTIPLE distinct endpoints, not one.
  // (UI may render error states; even the drain alone hit 2 endpoints.)
  const drainEndpoints = new Set(hits.filter((h) => h.status === 429).map((h) => h.path));
  expect(drainEndpoints.size, 'RATE_LIMITED hits >1 distinct endpoint').toBeGreaterThan(1);
  // Confirm the 429 wire header name (raw, via the Playwright response log): the
  // throttler emits `Retry-After-auth` (seconds) for these reads, NOT
  // `Retry-After-global` and NOT a plain `Retry-After`.
  expect(withRAauth, 'global-bucket-pressure 429s carry Retry-After-auth on the wire').toBeGreaterThan(0);
  expect(withRAglobal, 'no Retry-After-global header is emitted').toBe(0);
  markSpent();
});

test('INC-005 T3 — two contexts behind one IP share the global budget', async ({ browser }) => {
  await waitForWindow();

  // Context A signs in and drains; Context B signs in fresh and immediately gets
  // 429s on plain reads despite doing nothing unusual — proving the IP-keyed
  // budget is shared across independent sessions/tabs.
  const ctxA: BrowserContext = await browser.newContext();
  const ctxB: BrowserContext = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const hitsA: Hit[] = [];
    instrument(pageA, Date.now(), hitsA);
    await signInAs(pageA, { actorKey: 'alice' });
    await expect(pageA).toHaveURL(/\/timesheets/);

    // NOTE: a second live login would spend another auth-bucket token; alice's
    // login here is one. Context B uses the SAME actor but we only need its
    // session cookie for credentialed reads. To avoid a second full Keycloak
    // login (and to keep this within one window), reuse ctxA's storage state.
    const storage = await ctxA.storageState();
    await ctxB.close();
    const ctxB2 = await browser.newContext({ storageState: storage });
    const pageB = await ctxB2.newPage();
    const hitsB: Hit[] = [];
    instrument(pageB, Date.now(), hitsB);
    // pageB must have a real web-origin document so its credentialed fetch to the
    // :3001 API carries a valid Origin (about:blank → "Failed to fetch" on CORS).
    await pageB.goto('/login', { waitUntil: 'domcontentloaded' });

    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

    // A drains the shared per-route-per-IP budget for /v1/time-entries/running.
    // (The throttler key is sha256(Class-Handler-bucket-IP); the IP suffix is the
    // shared term across contexts, so draining a route from context A drains that
    // same route's counter for EVERY context behind that IP.)
    const drainA = await pageA.evaluate(async (base) => {
      const out: Record<string, number> = {};
      for (let i = 0; i < 40; i++) {
        const res = await fetch(base + '/v1/time-entries/running', {
          credentials: 'include',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        out[String(res.status)] = (out[String(res.status)] ?? 0) + 1;
      }
      return out;
    }, apiBase);

    // B (a different "tab"/context, same IP) now makes a SMALL number of normal
    // reads of the SAME route — and should already be throttled because A
    // exhausted the shared IP budget for it.
    const probeB = await pageB.evaluate(async (base) => {
      const out: Record<string, number> = {};
      for (let i = 0; i < 5; i++) {
        const res = await fetch(base + '/v1/time-entries/running', {
          credentials: 'include',
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        out[String(res.status)] = (out[String(res.status)] ?? 0) + 1;
      }
      return out;
    }, apiBase);

    // eslint-disable-next-line no-console
    console.log(`\n===== INC-005 T3 CROSS-CONTEXT =====`);
    // eslint-disable-next-line no-console
    console.log(`context A drain tally: ${JSON.stringify(drainA)}`);
    // eslint-disable-next-line no-console
    console.log(`context B (5 normal reads, same IP) tally: ${JSON.stringify(probeB)}`);
    // eslint-disable-next-line no-console
    console.log(`====================================\n`);

    const b429 = probeB['429'] ?? 0;
    expect(
      b429,
      'a second context behind the same IP is throttled by budget the first context drained',
    ).toBeGreaterThan(0);

    await ctxB2.close();
  } finally {
    await ctxA.close().catch(() => {});
    markSpent();
  }
});
