import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

// Hermetic-only: k=5 fixture has 4 employees and the mock-api hard-codes
// the K_ANONYMITY_THRESHOLD path; live mode would depend on DB seed counts.
test.skip(isLiveMode(), 'hermetic-only — fixture-bound k threshold');

test.describe('Journey 10: mood — weekly aggregate k-anonymity (k≥5)', () => {
  test('Manager request for team mood aggregate fails K_ANONYMITY_THRESHOLD with fixture (4 employees)', async ({
    page,
  }) => {
    // RBAC_TEST_FIXTURE has only Bob/Carol/Dave/Grace as employees — 4 in
    // total, below the k=5 threshold. The aggregate endpoint MUST refuse
    // rather than leak; this is the canonical privacy behaviour.
    await signInAs(page, { actorKey: 'alice', landingPath: '/dashboard' });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(
          `${apiBase}/v1/mood/team-aggregate?from=2026-05-01&to=2026-05-31`,
          { credentials: 'include' },
        );
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(422);
    expect((resp.body as { code: string }).code).toBe('K_ANONYMITY_THRESHOLD');
    expect(
      (resp.body as { details: { sample_size: number } }).details.sample_size,
    ).toBeLessThan(5);
  });

  test('Employee can read their own mood entries via GET /v1/mood/me', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    handle.state.moodByUserDate.set(`${handle.state.actor.id}:2026-05-20`, 4);
    handle.state.moodByUserDate.set(`${handle.state.actor.id}:2026-05-21`, 5);

    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/mood/me`, { credentials: 'include' });
        return { status: r.status, body: await r.json() };
      },
      { apiBase },
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { items: unknown[] }).items.length).toBe(2);
  });

  test('Posting the same date twice returns VALIDATION_FAILED (once-per-day UNIQUE)', async ({
    page,
  }) => {
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const first = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/mood/entries`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ score: 4 }),
        });
        return r.status;
      },
      { apiBase },
    );
    expect(first).toBe(201);
    const second = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/mood/entries`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ score: 5 }),
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase },
    );
    expect(second.status).toBe(400);
    expect((second.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});
