/**
 * THROWAWAY REPRO 4 — INC-002. Does clicking the button BEFORE hydration
 * (or with JS disabled / scripts blocked) leave the user on /login with no
 * redirect? This models the "stale cached broken-CSP bundle" / pre-hydration
 * symptom the reporter may be seeing.
 */
import { test, expect } from '@playwright/test';

test('INC-002e: JS DISABLED — button does nothing (stays on /login)', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  const btn = page.getByRole('button', { name: /continue with microsoft/i });
  await expect(btn).toBeVisible(); // static SSR button renders
  await btn.click({ force: true });
  await page.waitForTimeout(1500);
  console.log('\n===== REPRO4 (JS disabled) =====');
  console.log('URL after click with NO hydration:', page.url());
  console.log('================================\n');
  await ctx.close();
});
