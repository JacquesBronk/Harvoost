/**
 * INC-004 browser-symptom pass (throwaway). Signs in, visits each failing page,
 * captures the failing network request (status) and the rendered failure UI
 * text ("Could not load data" / EmptyState). Confirms the user-visible symptom.
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { signInAs } from '../../../../../../tests/e2e/fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const OUT = process.env.INC004_OUT ?? '/tmp/inc004-browser';

const AUTH_THROTTLE_TTL_MS = 60_000;
let lastAuth = Date.now() - AUTH_THROTTLE_TTL_MS;
async function waitAuthWindow() {
  const target = lastAuth + AUTH_THROTTLE_TTL_MS + 2_000;
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

function track(page: import('@playwright/test').Page, substrings: string[]) {
  const hits: string[] = [];
  page.on('response', (resp) => {
    const u = resp.url();
    if (substrings.some((s) => u.includes(s))) {
      hits.push(`${resp.status()} ${u.replace(apiBase, '')}`);
    }
  });
  return hits;
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('admin browser pass: /dashboard /financial /schedule /admin/rates', async ({ page }) => {
  test.setTimeout(180_000);
  await waitAuthWindow();
  // Admin sees every page (dashboard/financial/rates are Admin/FinMgr-gated).
  await signInAs(page, { actorKey: 'admin' });
  lastAuth = Date.now();
  let log = `=== ADMIN browser pass ${new Date().toISOString()} ===\n`;

  for (const [path, apiNeedles] of [
    ['/dashboard', ['/v1/reports/team-dashboard']],
    ['/financial', ['/v1/reports/profitability']],
    ['/schedule', ['/v1/schedules/dashboard']],
    ['/admin/rates', ['/v1/cost-rates', '/v1/billable-rates']],
  ] as Array<[string, string[]]>) {
    const hits = track(page, apiNeedles);
    await page.goto(path);
    // Let queries fire + render the error/empty state.
    await page.waitForTimeout(3500);
    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600);
    log += `\n--- ${path} ---\n  api responses: ${JSON.stringify(hits)}\n  visible text: ${bodyText}\n`;
    page.removeAllListeners('response');
  }
  writeFileSync(`${OUT}.txt`, log);
  console.log(log);
});
