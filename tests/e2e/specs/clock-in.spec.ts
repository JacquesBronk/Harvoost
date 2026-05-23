import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { PROJECTS } from '../fixtures/rbac.js';

// Hermetic-only: assertions inspect the in-process mock-api state which has
// no counterpart in live mode. The OIDC handshake itself is exercised by
// oidc-flow.spec.ts in the live lane.
test.skip(isLiveMode(), 'hermetic-only — mock-state assertions');

test.describe('Journey 2: clock-in via web + record mood', () => {
  test('TimerBar shows "No active timer" when no entry is running', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob' });
    await expect(page.getByText('No active timer')).toBeVisible();
    await expect(page.getByRole('link', { name: /start one from timesheets/i })).toBeVisible();
  });

  test('TimerBar reflects a running entry started server-side', async ({ page }) => {
    await signInAs(page, {
      actorKey: 'bob',
      initialRunningEntry: { project_key: 'P1', mood_score: 4 },
    });
    await expect(page.getByText('Running')).toBeVisible();
    await expect(page.getByText(PROJECTS.P1.name)).toBeVisible();
    await expect(page.getByLabel('elapsed time')).toBeVisible();
    await expect(page.getByRole('button', { name: /^stop$/i })).toBeVisible();
  });

  test('stopping the timer calls /v1/time-entries/stop with an Idempotency-Key', async ({
    page,
  }) => {
    const handle = await signInAs(page, {
      actorKey: 'bob',
      initialRunningEntry: { project_key: 'P1', mood_score: 4 },
    });
    await page.getByRole('button', { name: /^stop$/i }).click();
    await expect(page.getByText('No active timer')).toBeVisible({ timeout: 15_000 });

    const stop = handle.requests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/v1/time-entries/stop'),
    );
    expect(stop, 'POST /v1/time-entries/stop was issued').toBeTruthy();
    expect(stop!.headers['idempotency-key']).toBeTruthy();
    expect(stop!.headers['idempotency-key']!.length).toBeGreaterThan(8);
  });

  test('after stopping, the entry persists across a page refresh', async ({ page }) => {
    const handle = await signInAs(page, {
      actorKey: 'bob',
      initialRunningEntry: { project_key: 'P1', mood_score: 4 },
    });
    await page.getByRole('button', { name: /^stop$/i }).click();
    await page.reload();
    await expect(page.getByText('No active timer')).toBeVisible();
    // Entry still in our /v1/time-entries listing (status=draft).
    const draftCount = Array.from(handle.state.entries.values()).filter(
      (e) => e.status === 'draft',
    ).length;
    expect(draftCount).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Journey 3: submit week + lock enforcement', () => {
  test('"Submit week" button is enabled only when all entries are draft', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob', seedSampleEntries: true });
    const submit = page.getByRole('button', { name: /submit week/i });
    await expect(submit).toBeEnabled();
  });

  test('submitting transitions draft entries to submitted', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'bob', seedSampleEntries: true });
    await page.getByRole('button', { name: /submit week/i }).click();
    // Toast appears, week status badges flip.
    await expect(page.getByText(/week submitted/i)).toBeVisible();
    // Reload to ensure the new state survives a refetch.
    await page.reload();
    const states = Array.from(handle.state.entries.values())
      .filter((e) => e.user_id === handle.state.actor.id)
      .map((e) => e.status);
    expect(states.every((s) => s === 'submitted')).toBe(true);
    // Status badges in the table now read "Submitted".
    await expect(page.getByText('Submitted').first()).toBeVisible();
  });

  test('editing a submitted entry returns ENTRY_LOCKED 409', async ({ page, request }) => {
    const handle = await signInAs(page, { actorKey: 'bob', seedSampleEntries: true });
    // Force-submit the first entry to simulate post-submission state.
    const firstId = Array.from(handle.state.entries.values())[0]!.id;
    handle.setEntryStatus(firstId, 'submitted');

    // Use the browser fetch (with the session cookie) to call the mock API.
    // X-Requested-With paired with credentials:'include' satisfies the CSRF
    // middleware (Finding 8); apiFetch does this automatically but our raw
    // page.evaluate fetch must replicate it.
    const response = await page.evaluate(
      async ({ entryId, apiBase }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/${entryId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ notes: 'attempt to edit submitted entry' }),
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      {
        entryId: firstId,
        apiBase: process.env.E2E_API_BASE_URL ?? 'http://localhost:3001',
      },
    );
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('ENTRY_LOCKED');
    void request;
  });
});
