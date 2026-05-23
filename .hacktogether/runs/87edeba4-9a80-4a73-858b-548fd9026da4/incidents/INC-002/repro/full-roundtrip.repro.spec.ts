/**
 * THROWAWAY REPRO 3 — INC-002. Full round-trip: sign in as alice and observe
 * where (if anywhere) the post-Keycloak flow breaks.
 */
import { test } from '@playwright/test';

test.use({ baseURL: 'http://localhost:3000' });
test.setTimeout(60_000);

test('INC-002d: full sign-in round-trip as alice', async ({ page }) => {
  const nav: string[] = [];
  const resp: string[] = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) nav.push(f.url()); });
  page.on('response', (r) => {
    if (/auth\/(oidc\/)?(login|callback)|v1\/auth\/callback|protocol\/openid-connect/.test(r.url())) {
      resp.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 110)}`);
    }
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /continue with microsoft/i }).click();

  await page.waitForURL(/harvoost\.localhost:8080/, { timeout: 15000 });
  await page.locator('#username').fill('alice');
  await page.locator('#password').fill('dev-alice-pass');
  await page.locator('#kc-login, button[type=submit], input[type=submit]').first().click();

  await page.waitForTimeout(6000);

  console.log('\n===== REPRO3 round-trip =====');
  console.log('FINAL URL:', page.url());
  console.log('NAVIGATIONS:');
  for (const u of nav) console.log('  ', u.slice(0, 130));
  console.log('AUTH RESPONSES:');
  for (const r of resp) console.log('  ', r);
  const bodyText = (await page.locator('body').innerText().catch(() => '(no body)')).slice(0, 300);
  console.log('LANDING BODY TEXT:', JSON.stringify(bodyText));
  console.log('=============================\n');
});
