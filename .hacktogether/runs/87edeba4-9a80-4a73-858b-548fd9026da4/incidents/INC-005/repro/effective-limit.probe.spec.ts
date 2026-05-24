/**
 * INC-005 — PROBE: what is the EFFECTIVE per-route read limit, and which named
 * bucket bites first? forRoot([chatbot 30, auth 5, global 300]) declares THREE
 * global named buckets. The stock guard enforces EVERY declared bucket on EVERY
 * route unless @SkipThrottle names it. So a plain read route is capped by the
 * SMALLEST applicable bucket. We measure: hit one fresh read endpoint N times in
 * a clean window and record the index of the first 429 + the Retry-After-* name.
 */
import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../../../../../../tests/e2e/fixtures/auth.js';

test.skip(!isLiveMode(), 'live-only');
test.describe.configure({ mode: 'serial' });

test('effective read limit + which bucket bites', async ({ page }) => {
  // Fresh full window before we start (clear auth + global).
  await new Promise((r) => setTimeout(r, 62_000));
  await signInAs(page, { actorKey: 'alice' });
  await expect(page).toHaveURL(/\/timesheets/);

  const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
  // Use a DEDICATED read endpoint not hit by the shell after landing, to isolate
  // the per-route counter as cleanly as possible: /v1/projects.
  const out = await page.evaluate(async (base) => {
    const seq: Array<{ i: number; status: number; ra: string | null; raAuth: string | null; raGlobal: string | null; raChatbot: string | null }> = [];
    for (let i = 1; i <= 40; i++) {
      const res = await fetch(base + '/v1/projects', {
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      seq.push({
        i,
        status: res.status,
        ra: res.headers.get('retry-after'),
        raAuth: res.headers.get('retry-after-auth'),
        raGlobal: res.headers.get('retry-after-global'),
        raChatbot: res.headers.get('retry-after-chatbot'),
      });
      if (res.status === 429 && i > 12) break; // enough evidence
    }
    return seq;
  }, apiBase);

  const first429 = out.find((o) => o.status === 429);
  // eslint-disable-next-line no-console
  console.log('\n===== INC-005 EFFECTIVE-LIMIT PROBE =====');
  for (const o of out) {
    // eslint-disable-next-line no-console
    console.log(`  #${String(o.i).padStart(2)} : ${o.status}` +
      (o.status === 429 ? `  RA=${o.ra} RA-auth=${o.raAuth} RA-global=${o.raGlobal} RA-chatbot=${o.raChatbot}` : ''));
  }
  // eslint-disable-next-line no-console
  console.log(`first 429 at request #${first429 ? first429.i : 'none'} on /v1/projects (fresh window)`);
  // eslint-disable-next-line no-console
  console.log(`=========================================\n`);

  // The fix-relevant facts: report which named header is set on the 429.
  expect(first429, 'a fresh read endpoint should 429 well before 300 if the auth/chatbot bucket bites').toBeTruthy();
});
