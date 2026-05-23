/**
 * INC-004 live reproduction (throwaway). Signs in via real Keycloak, then
 * issues each frontend-shaped request from the browser context (HttpOnly
 * cookie carried automatically) and records status+body. Also issues the
 * "correct contract" variants to prove the backend works when called per its
 * own @Query('date_range') contract.
 *
 * Run from tests/e2e with the repro config:
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 npx playwright test \
 *     --config ../../.hacktogether/.../repro/playwright.repro.config.ts
 */
import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { signInAs } from '../../../../../../tests/e2e/fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const OUT = process.env.INC004_OUT ?? '/tmp/inc004';

const AUTH_THROTTLE_TTL_MS = 60_000;
let lastAuth = Date.now() - AUTH_THROTTLE_TTL_MS;
async function waitAuthWindow() {
  const target = lastAuth + AUTH_THROTTLE_TTL_MS + 2_000;
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

async function probe(page: import('@playwright/test').Page, label: string, path: string) {
  const res = await page.evaluate(async ({ apiBase, path }) => {
    const r = await fetch(`${apiBase}${path}`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    });
    let body: unknown;
    const text = await r.text();
    try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
    return { status: r.status, body };
  }, { apiBase, path });
  const line = `[${label}] GET ${path}\n  -> ${res.status}\n  body: ${JSON.stringify(res.body)}\n`;
  console.log(line);
  return line;
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('row1+row3 (Alice manager): dashboard team-dashboard + schedules/dashboard', async ({ page }) => {
  test.setTimeout(180_000);
  await waitAuthWindow();
  await signInAs(page, { actorKey: 'alice' });
  lastAuth = Date.now();
  let log = `=== ALICE (manager) ${new Date().toISOString()} ===\n`;
  // Row 1: exactly as apps/web/app/dashboard/page.tsx calls it (ISO ts params).
  log += await probe(page, 'ROW1 dashboard FE-shape', '/v1/reports/team-dashboard?start_at_from=2026-05-18T00:00:00.000Z&start_at_to=2026-05-25T00:00:00.000Z');
  // Row 1 correct backend contract (date_range=YYYY-MM-DD/YYYY-MM-DD).
  log += await probe(page, 'ROW1 dashboard BE-contract', '/v1/reports/team-dashboard?date_range=2026-05-18/2026-05-25');
  // Row 3: exactly as apps/web/app/schedule/page.tsx calls it.
  log += await probe(page, 'ROW3 schedule FE-shape', '/v1/schedules/dashboard?tab=team&date_from=2026-05-18&date_to=2026-05-25');
  writeFileSync(`${OUT}-alice.txt`, log);
});

test('row2+row4+row5 (admin): profitability + cost-rates + billable-rates', async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.clearCookies();
  await waitAuthWindow();
  await signInAs(page, { actorKey: 'admin' });
  lastAuth = Date.now();
  let log = `=== ADMIN ${new Date().toISOString()} ===\n`;
  // Row 2: exactly as apps/web/app/financial/page.tsx calls it (no date_range).
  log += await probe(page, 'ROW2 financial FE-shape', '/v1/reports/profitability?group_by=project&limit=100');
  // Row 2 correct backend contract.
  log += await probe(page, 'ROW2 financial BE-contract', '/v1/reports/profitability?date_range=2026-05-01/2026-05-31');
  // Row 4: exactly as apps/web/app/admin/rates/page.tsx calls it.
  log += await probe(page, 'ROW4 cost-rates FE-shape', '/v1/cost-rates?current=true&page=1&page_size=200');
  // Row 5.
  log += await probe(page, 'ROW5 billable-rates FE-shape', '/v1/billable-rates?current=true&page=1&page_size=200');
  writeFileSync(`${OUT}-admin.txt`, log);
});
