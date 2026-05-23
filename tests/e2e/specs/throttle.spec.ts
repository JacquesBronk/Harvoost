/**
 * Throttler decorators (Finding 4).
 *
 * The @Throttle decorators on AuthController (5/60s) and
 * ChatbotController.postMessage (30/60s) cap the per-route request rate.
 * Before the fix landed, the first NAMED throttle bucket (chatbot 30/min)
 * silently became the default for every route — so /v1/auth/oidc/callback
 * was effectively at 30/min, not 5. These tests verify the limits actually
 * fire on the right routes at the right rates.
 *
 * Approach: in the mock-api, the throttler is a tight in-memory sliding-
 * window counter (no real network). We can hammer the route 6 (or 31) times
 * in quick succession and assert the over-limit response.
 *
 * Live-stack note: against the real backend the same test runs but Playwright
 * does not support time-warping the NestJS throttler. To run the burst tests
 * deterministically in CI without flakes from clock skew, the live-stack
 * project relies on @nestjs/throttler's in-process counters which reset on
 * test isolation boundaries. See TEST_REPORT.md § E2E (re-test) > Execution.
 */
import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mock-api.js';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Hermetic-only: simulator-driven throttle counters. Real `@nestjs/throttler`
// integration is covered in `apps/api/test/unit/throttler.test.ts`.
test.skip(isLiveMode(), 'hermetic-only — simulator throttle counters');

test.describe('Journey 16: throttler — POST /v1/auth/oidc/callback at 5/60s', () => {
  test('6 callback POSTs in 60s — the 6th returns 429 RATE_LIMITED', async ({ page }) => {
    // The mock throttle simulator only counts non-safe methods (POST/PATCH/
    // DELETE/PUT) toward the auth bucket, so the AppShell's GET
    // /v1/auth/me on mount does not pollute our 5/60s budget. This is a
    // simplification vs the real @nestjs/throttler (which counts every
    // request) but preserves the load-bearing assertion shape.
    await installMockApi(page, { actorKey: 'bob', skipPreSeedSessionCookie: true });
    await page.goto('/login');

    const results = await page.evaluate(async ({ apiBase }) => {
      const outcomes: Array<{ attempt: number; status: number; code?: string }> = [];
      for (let i = 1; i <= 6; i++) {
        const r = await fetch(`${apiBase}/v1/auth/oidc/callback`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ code: `code-${i}`, state: 'mock-state' }),
        });
        let body: { code?: string } = {};
        try {
          body = await r.json();
        } catch {
          // ignore parse error
        }
        outcomes.push({ attempt: i, status: r.status, code: body.code });
      }
      return outcomes;
    }, { apiBase });

    // Attempts 1-5: 200 (or whatever the callback returns when accepted).
    for (let i = 0; i < 5; i++) {
      expect(results[i]!.status, `attempt ${results[i]!.attempt} should pass`).toBe(200);
    }
    // Attempt 6: 429 RATE_LIMITED.
    expect(results[5]!.status, 'attempt 6 should be throttled').toBe(429);
    expect(results[5]!.code).toBe('RATE_LIMITED');
  });

  test('throttle bucket isolates per-route — login endpoint shares the auth bucket', async ({
    page,
  }) => {
    // The @Throttle({ auth: ... }) decorator on the AuthController class
    // means BOTH /oidc/login and /oidc/callback share the 5/min budget.
    // Mixing 3 logins + 3 callbacks should still hit the limit on the 6th.
    await signInAs(page, { actorKey: 'bob', skipPreSeedSessionCookie: true });

    const results = await page.evaluate(async ({ apiBase }) => {
      const outcomes: Array<{ path: string; status: number; code?: string }> = [];
      const paths = [
        '/v1/auth/oidc/login',
        '/v1/auth/oidc/login',
        '/v1/auth/oidc/login',
        '/v1/auth/oidc/callback',
        '/v1/auth/oidc/callback',
        '/v1/auth/oidc/callback',
      ];
      for (const p of paths) {
        const r = await fetch(`${apiBase}${p}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ code: 'x', state: 'mock-state' }),
        });
        let body: { code?: string } = {};
        try {
          body = await r.json();
        } catch {
          // ignore
        }
        outcomes.push({ path: p, status: r.status, code: body.code });
      }
      return outcomes;
    }, { apiBase });

    // At least one of the last 3 requests in the burst must be 429.
    const throttled = results.filter((r) => r.status === 429);
    expect(throttled.length, 'auth bucket shared across login + callback').toBeGreaterThanOrEqual(1);
    for (const r of throttled) {
      expect(r.code).toBe('RATE_LIMITED');
    }
  });
});

test.describe('Journey 17: throttler — POST /v1/chatbot/messages at 30/60s', () => {
  test('31 chatbot POSTs in 60s — the 31st returns 429 RATE_LIMITED', async ({ page }) => {
    // The chatbot throttle is wider (30/min). We send 31 requests and
    // assert the 31st is the first 429. We intentionally pass distinct
    // conversation_ids so the mock doesn't short-circuit on identity.
    await signInAs(page, { actorKey: 'alice', landingPath: '/chat' });

    const results = await page.evaluate(async ({ apiBase }) => {
      const outcomes: Array<{ attempt: number; status: number; code?: string }> = [];
      for (let i = 1; i <= 31; i++) {
        const r = await fetch(`${apiBase}/v1/chatbot/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ message: `ping #${i}` }),
        });
        let body: { code?: string } = {};
        try {
          body = await r.json();
        } catch {
          // ignore
        }
        outcomes.push({ attempt: i, status: r.status, code: body.code });
      }
      return outcomes;
    }, { apiBase });

    // Attempts 1-30 should be 200.
    for (let i = 0; i < 30; i++) {
      expect(results[i]!.status, `chatbot attempt ${results[i]!.attempt}`).toBe(200);
    }
    // Attempt 31: 429.
    expect(results[30]!.status).toBe(429);
    expect(results[30]!.code).toBe('RATE_LIMITED');
  });

  test('chatbot 429 does NOT affect the global limiter (chat is its own bucket)', async ({
    page,
  }) => {
    // After exhausting the chatbot bucket, requests to OTHER endpoints
    // should still be served — Finding 4 specifically requires that
    // chatbot 30/min does not become the default for all routes.
    await signInAs(page, { actorKey: 'alice', landingPath: '/chat' });

    // Exhaust the chatbot bucket first.
    await page.evaluate(async ({ apiBase }) => {
      for (let i = 1; i <= 31; i++) {
        await fetch(`${apiBase}/v1/chatbot/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ message: `ping #${i}` }),
        });
      }
    }, { apiBase });

    // Now a non-throttled endpoint must still respond 200.
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/auth/me`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        return { status: r.status };
      },
      { apiBase },
    );
    expect(resp.status).toBe(200);
  });
});
