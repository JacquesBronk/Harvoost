/**
 * CSRF middleware (Finding 8).
 *
 * The backend now requires browser POST/PATCH/DELETE/PUT requests to send
 * either:
 *   (a) `X-Requested-With: XMLHttpRequest` header, OR
 *   (b) `Authorization: Bearer ...` (the tray path), OR
 *   (c) an Origin header that is in CORS_ALLOWED_ORIGINS.
 *
 * Otherwise the request is rejected with 403 CSRF_FAILURE before reaching
 * any controller. Safe methods (GET/HEAD/OPTIONS) are always exempt.
 *
 * These tests bypass the apiFetch wrapper (which always sends the XRW
 * header) by using `page.evaluate(fetch(...))` directly. The first
 * argument's `evalOpts` lets us toggle each header independently.
 */
import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { PROJECTS } from '../fixtures/rbac.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Hermetic-only: the mock-api's csrfCheck() matches the backend's exact
// rejection text. Live mode would still 403 but the error body shape would
// need a separate spec. CSRF middleware itself is covered server-side by
// `apps/api/test/unit/csrf-middleware.test.ts`.
test.skip(isLiveMode(), 'hermetic-only — exact error body asserted');

test.describe('Journey 15: CSRF middleware (Finding 8)', () => {
  test('cookie-auth POST without X-Requested-With and without allowed Origin -> 403 CSRF_FAILURE', async ({
    page,
  }) => {
    // We sign in normally, then craft a POST that omits both XRW and Origin.
    // In a real cross-site attack, the attacker's page would not be able to
    // OMIT the Origin header (the browser inserts it), but it would not
    // match the allow-list either. Here we simulate "Origin missing" by
    // pointing fetch at the same origin from a worker-like context where
    // the Origin is intentionally not appended.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const resp = await page.evaluate(
      async ({ apiBase, projectId }) => {
        // Strip the Origin header by going through a request whose `mode`
        // is 'no-cors'. (Playwright/Chromium still sends Origin in many
        // cases, so we additionally simulate the attack by forging an
        // out-of-allow-list Origin.)
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'csrf-test-1',
            Origin: 'https://evil.example.test',
          },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase, projectId: PROJECTS.P1.id },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('CSRF_FAILURE');
  });

  test('cookie-auth POST WITH X-Requested-With -> succeeds', async ({ page }) => {
    // This is the canonical web-client request shape (matches what apiFetch
    // sends). The CSRF middleware sees the XRW header and lets the request
    // through; the controller does the rest.
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const resp = await page.evaluate(
      async ({ apiBase, projectId }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'csrf-test-2',
            'X-Requested-With': 'XMLHttpRequest',
            // Also force a bad Origin to prove XRW alone is sufficient.
            Origin: 'https://evil.example.test',
          },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        return { status: r.status };
      },
      { apiBase, projectId: PROJECTS.P1.id },
    );
    expect(resp.status).toBe(201);
    // The entry should be in the running state.
    const running = Array.from(handle.state.entries.values()).filter(
      (e) => e.user_id === handle.state.actor.id && e.status === 'running',
    );
    expect(running.length).toBe(1);
  });

  test('cookie-auth POST with allow-listed Origin (no XRW) -> succeeds', async ({ page }) => {
    // Origin-allowlist branch: a request from http://localhost:3000 (or the
    // configured E2E_WEB_BASE_URL) is treated as same-origin trust and
    // passes even without XRW. This is the default browser behaviour when
    // the page making the fetch is the SPA itself.
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const webOrigin = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000';
    const resp = await page.evaluate(
      async ({ apiBase, projectId, webOrigin }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'csrf-test-3',
            Origin: webOrigin,
          },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        return { status: r.status };
      },
      { apiBase, projectId: PROJECTS.P1.id, webOrigin },
    );
    expect(resp.status).toBe(201);
    void handle;
  });

  test('cookie-auth GET without X-Requested-With -> succeeds (safe method)', async ({ page }) => {
    // Safe methods (GET/HEAD/OPTIONS) are always exempt from CSRF checks.
    // The CSRF middleware short-circuits before checking headers.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/auth/me`, {
          method: 'GET',
          credentials: 'include',
          headers: {
            // Intentionally no XRW, intentionally bad Origin.
            Origin: 'https://evil.example.test',
          },
        });
        return { status: r.status };
      },
      { apiBase },
    );
    expect(resp.status).toBe(200);
  });

  test('PATCH and DELETE with no XRW and bad Origin -> 403 CSRF_FAILURE', async ({ page }) => {
    // PATCH and DELETE are also state-changing and must be subject to the
    // same CSRF check as POST.
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    handle.state.entries.set('e-csrf', {
      id: 'e-csrf',
      user_id: handle.state.actor.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: null,
      status: 'draft',
      billable: true,
    });
    const patch = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/e-csrf`, {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example.test',
          },
          body: JSON.stringify({ notes: 'attempted CSRF edit' }),
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase },
    );
    expect(patch.status).toBe(403);
    expect((patch.body as { code: string }).code).toBe('CSRF_FAILURE');

    const del = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/e-csrf`, {
          method: 'DELETE',
          credentials: 'include',
          headers: { Origin: 'https://evil.example.test' },
        });
        const body = await r.json().catch(() => null);
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(del.status).toBe(403);
    expect((del.body as { code: string }).code).toBe('CSRF_FAILURE');
  });

  test('Bearer-authenticated POST (tray path) is exempt from CSRF middleware', async ({
    page,
  }) => {
    // The tray sends Authorization: Bearer ...; the CSRF middleware
    // short-circuits on Bearer regardless of XRW or Origin. We use a POST
    // here (not GET) so that the assertion is meaningful — GET would be
    // exempt under the safe-method branch anyway. Bad Origin + no XRW +
    // Authorization: Bearer present → CSRF middleware lets it through.
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const resp = await page.evaluate(
      async ({ apiBase, projectId }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'csrf-bearer-1',
            Authorization: 'Bearer mock-session-token-for-e2e',
            // Intentionally NO X-Requested-With and force a hostile Origin.
            Origin: 'https://evil.example.test',
          },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        let body: { code?: string } = {};
        try {
          body = await r.json();
        } catch {
          // ignore
        }
        return { status: r.status, code: body.code };
      },
      { apiBase, projectId: '101' },
    );
    // Whatever the auth guard decides downstream, the CSRF middleware did
    // NOT 403. (The mock-api doesn't validate the Bearer token — it just
    // skips the CSRF check on its presence — so the POST gets routed to
    // the time-entries controller and succeeds as 201.)
    expect(resp.code, 'CSRF middleware must not reject bearer-auth POST').not.toBe('CSRF_FAILURE');
    expect(resp.status, 'bearer-auth POST should not be 403 from CSRF').not.toBe(403);
  });
});
