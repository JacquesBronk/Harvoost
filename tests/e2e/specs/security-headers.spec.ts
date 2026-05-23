/**
 * Security headers (Finding 10).
 *
 * helmet middleware mounted in apps/api/src/main.ts must emit:
 *   - Strict-Transport-Security: max-age=31536000; includeSubDomains
 *   - X-Content-Type-Options: nosniff
 *   - Referrer-Policy: no-referrer
 *
 * These tests assert the presence and shape of those headers on a real
 * response from the API. The mock-api injects the same headers (see
 * fixtures/mock-api.ts), so the hermetic CI lane gets the same coverage.
 *
 * No Content-Security-Policy: the API serves JSON only; CSP is intentionally
 * disabled (`contentSecurityPolicy: false` in the helmet config). Asserting
 * absence guards against a future foot-gun where an over-eager helmet
 * default breaks Swagger UI or browser pre-flight.
 */
import { expect, test } from '@playwright/test';
import { signInAs } from '../fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

test.describe('Journey 18: security headers (Finding 10)', () => {
  test('GET /v1/auth/me — HSTS, nosniff, no-referrer all present', async ({ page }) => {
    // Sign-in primes the mock-api; the headers are consistently injected on
    // every response, including GETs.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });

    let headers: Record<string, string> = {};
    page.on('response', (resp) => {
      if (resp.url().endsWith('/v1/auth/me') && resp.request().method() === 'GET') {
        headers = resp.headers();
      }
    });
    await page.reload();
    await expect.poll(() => Object.keys(headers).length).toBeGreaterThan(0);

    // Strict-Transport-Security: must include max-age and includeSubDomains.
    const hsts = headers['strict-transport-security'];
    expect(hsts, 'HSTS header present').toBeTruthy();
    expect(hsts).toMatch(/max-age=(\d+)/);
    const maxAge = Number(/max-age=(\d+)/.exec(hsts!)?.[1] ?? '0');
    expect(maxAge, 'max-age >= 1 year (31536000s)').toBeGreaterThanOrEqual(31536000);
    expect(hsts).toMatch(/includesubdomains/i);

    // X-Content-Type-Options: nosniff.
    expect(headers['x-content-type-options']).toBe('nosniff');

    // Referrer-Policy: no-referrer.
    expect(headers['referrer-policy']).toBe('no-referrer');
  });

  test('POST responses also carry the security headers', async ({ page }) => {
    // Helmet headers apply to ALL responses regardless of method. Test a
    // POST path to make sure no middleware ordering issue strips them on
    // state-changing routes.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });

    const captured: Record<string, string> = {};
    page.on('response', (resp) => {
      if (resp.url().endsWith('/v1/time-entries/start') && resp.request().method() === 'POST') {
        Object.assign(captured, resp.headers());
      }
    });

    await page.evaluate(
      async ({ apiBase }) => {
        await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'sec-hdr-1',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ project_id: '101', mood_score: 4 }),
        });
      },
      { apiBase },
    );
    await expect.poll(() => Object.keys(captured).length).toBeGreaterThan(0);

    expect(captured['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(captured['x-content-type-options']).toBe('nosniff');
    expect(captured['referrer-policy']).toBe('no-referrer');
  });

  test('error responses (403, 404, etc.) still carry the security headers', async ({ page }) => {
    // CSRF rejection path: 403 with no body content type matters less than
    // the helmet headers being present so the browser still enforces HSTS.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });

    const captured: Record<string, string> = {};
    page.on('response', (resp) => {
      // The CSRF rejection happens on the leave POST below.
      if (resp.url().endsWith('/v1/leave/requests') && resp.request().method() === 'POST') {
        Object.assign(captured, resp.headers());
      }
    });

    await page.evaluate(
      async ({ apiBase }) => {
        await fetch(`${apiBase}/v1/leave/requests`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            // Intentionally omit X-Requested-With AND use a bad Origin to
            // trigger CSRF rejection.
            Origin: 'https://evil.example.test',
          },
          body: JSON.stringify({
            leave_type: 'annual',
            start_date: '2026-06-01',
            end_date: '2026-06-05',
          }),
        });
      },
      { apiBase },
    );
    await expect.poll(() => Object.keys(captured).length).toBeGreaterThan(0);
    expect(captured['strict-transport-security']).toBeTruthy();
    expect(captured['x-content-type-options']).toBe('nosniff');
    expect(captured['referrer-policy']).toBe('no-referrer');
  });

  test('Content-Security-Policy is intentionally absent (API serves JSON)', async ({ page }) => {
    // helmet({ contentSecurityPolicy: false }) — the API is a JSON service,
    // not an HTML surface. A misplaced default CSP would block Swagger UI
    // and cause cryptic browser console errors. Document the intentional
    // absence so future helmet upgrades don't silently flip it back on.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    let headers: Record<string, string> = {};
    page.on('response', (resp) => {
      if (resp.url().endsWith('/v1/auth/me') && resp.request().method() === 'GET') {
        headers = resp.headers();
      }
    });
    await page.reload();
    await expect.poll(() => Object.keys(headers).length).toBeGreaterThan(0);
    expect(headers['content-security-policy']).toBeUndefined();
  });
});
