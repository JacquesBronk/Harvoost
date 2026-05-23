/**
 * THROWAWAY REPRO 2 — INC-002. Tests env-difference hypotheses:
 *  (A) CSP securitypolicyviolation events on the page during click.
 *  (B) What happens if harvoost.localhost is NOT resolvable (simulate via
 *      blocking that host) — does the page "stay on /login with no redirect"?
 *  (C) Click immediately after DOMContentLoaded (no networkidle wait).
 */
import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:3000' });

test('INC-002b: CSP violations + immediate click', async ({ page }) => {
  const csp: string[] = [];
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e: any) => {
      (window as any).__csp = (window as any).__csp || [];
      (window as any).__csp.push(
        `VIOLATION dir=${e.violatedDirective} blocked=${e.blockedURI} src=${e.sourceFile}`,
      );
    });
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const btn = page.getByRole('button', { name: /continue with microsoft/i });
  await btn.click();
  await page.waitForTimeout(2500);
  const finalUrl = page.url();
  const cspViolations = await page.evaluate(() => (window as any).__csp ?? []).catch(() => ['(page navigated, could not read)']);

  console.log('\n===== REPRO2 (immediate click) =====');
  console.log('FINAL URL:', finalUrl);
  console.log('CSP VIOLATIONS:', JSON.stringify(cspViolations));
  console.log('PAGE ERRORS:', JSON.stringify(errs));
  console.log('====================================\n');
});

test('INC-002c: simulate UNRESOLVABLE harvoost.localhost', async ({ page, context }) => {
  // Abort any navigation/request to harvoost.localhost to mimic a host where
  // the *.localhost subdomain magic does NOT apply (some corp DNS / older UAs).
  await context.route('**://harvoost.localhost:**/**', (route) => route.abort('namenotresolved'));
  const errs: string[] = [];
  const failed: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.url()} -> ${r.failure()?.errorText}`));

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const btn = page.getByRole('button', { name: /continue with microsoft/i });
  await btn.click();
  await page.waitForTimeout(2500);

  console.log('\n===== REPRO2c (harvoost.localhost blocked) =====');
  console.log('FINAL URL:', page.url());
  console.log('FAILED REQUESTS:', JSON.stringify(failed));
  console.log('PAGE ERRORS:', JSON.stringify(errs));
  console.log('================================================\n');
});
