/**
 * THROWAWAY REPRO SPEC — INC-002 (debugger triage).
 * Drives a real Chromium against the running docker-compose stack to observe
 * the /login click handler at runtime: console errors, network, CSP violations,
 * and whether window.location.assign reaches harvoost.localhost:8080.
 *
 * Run with: E2E_SKIP_WEB_SERVER=1 npx playwright test specs/_inc002_repro.spec.ts --project=chromium-mocked
 * DELETE after triage (see HOTFIX_PLAN.md).
 */
import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:3000' });

test('INC-002: observe /login sign-in click', async ({ page }) => {
  const consoleMsgs: string[] = [];
  const pageErrors: string[] = [];
  const failedReqs: string[] = [];
  const responses: string[] = [];
  const navigations: string[] = [];

  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
  page.on('requestfailed', (r) =>
    failedReqs.push(`${r.method()} ${r.url()} -> ${r.failure()?.errorText ?? '?'}`),
  );
  page.on('response', (r) => {
    if (/auth\/oidc\/login|harvoost\.localhost|protocol\/openid-connect/.test(r.url())) {
      responses.push(`${r.status()} ${r.url()}`);
    }
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations.push(f.url());
  });

  await page.goto('/login', { waitUntil: 'networkidle' });
  navigations.push(`AFTER_LOAD: ${page.url()}`);

  // Confirm the button exists & is wired (rule out suspect #5).
  const btn = page.getByRole('button', { name: /continue with microsoft/i });
  await expect(btn).toBeVisible();

  // Probe: is the click handler attached & does env.WEB_BASE_URL resolve?
  const probe = await page.evaluate(() => {
    return {
      // What the page bundle resolves for the API base & web base.
      // (these come from the compiled env module via NEXT_PUBLIC_*).
      apiBaseViaProcess: (window as any).process?.env?.NEXT_PUBLIC_API_BASE_URL ?? null,
      webBaseViaProcess: (window as any).process?.env?.NEXT_PUBLIC_WEB_BASE_URL ?? null,
      hasProcess: typeof (window as any).process,
    };
  });

  // Simulate the EXACT fetch the handler triggers, from inside the page origin.
  const fetchProbe = await page.evaluate(async () => {
    try {
      const r = await fetch('http://localhost:3001/v1/auth/oidc/login', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ redirect_uri: 'http://localhost:3000/auth/callback' }),
        credentials: 'include',
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, body: text.slice(0, 400) };
    } catch (e) {
      return { error: String(e) };
    }
  });

  // Now actually click and wait briefly for navigation toward Keycloak.
  await btn.click();
  await page.waitForTimeout(3000);

  const finalUrl = page.url();

  console.log('\n========== INC-002 REPRO OUTPUT ==========');
  console.log('PROBE env:', JSON.stringify(probe));
  console.log('FETCH probe (manual POST from page):', JSON.stringify(fetchProbe));
  console.log('FINAL URL after click:', finalUrl);
  console.log('NAVIGATIONS:', JSON.stringify(navigations, null, 2));
  console.log('RELEVANT RESPONSES:', JSON.stringify(responses, null, 2));
  console.log('FAILED REQUESTS:', JSON.stringify(failedReqs, null, 2));
  console.log('PAGE ERRORS:', JSON.stringify(pageErrors, null, 2));
  console.log('CONSOLE:', JSON.stringify(consoleMsgs, null, 2));
  console.log('==========================================\n');
});
