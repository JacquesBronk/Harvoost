import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { PROJECTS } from '../fixtures/rbac.js';

// Hermetic-only: assertions inspect the in-process mock-api state which has
// no counterpart in live mode. The OIDC handshake itself is exercised by
// oidc-flow.spec.ts in the live lane.
test.skip(isLiveMode(), 'hermetic-only — mock-state assertions');

test.describe('Journey 2: clock-in via web + record mood', () => {
  test('TimerBar shows "No active timer" with a real Start affordance when nothing is running', async ({
    page,
  }) => {
    await signInAs(page, { actorKey: 'bob' });
    await expect(page.getByText('No active timer')).toBeVisible();
    // FEAT-001 (GitHub #5): the dead "Start one from timesheets" LINK is gone.
    // The idle bar now exposes a real Start affordance — a "Start timer" button
    // that toggles an inline start panel (StartTimerControl) — replacing the
    // dead-end link. Assert the button is present and the dead link is gone.
    await expect(
      page.getByRole('link', { name: /start one from timesheets/i }),
    ).toHaveCount(0);
    const startButton = page.getByRole('button', { name: /^start timer$/i });
    await expect(startButton).toBeVisible();
    // The start panel is collapsed until invoked; opening it reveals the shared
    // StartTimerControl with its required Project picker (the projects come from
    // the mock GET /v1/projects, RBAC-scoped to Bob's two projects).
    await expect(startButton).toHaveAttribute('aria-expanded', 'false');
    await startButton.click();
    await expect(startButton).toHaveAttribute('aria-expanded', 'true');
    // Scope to the TimerBar's own start panel — the /timesheets page ALSO renders
    // an inline StartTimerControl ("Start a timer" card), so an unscoped Project
    // picker query would match both. The bar's panel is the affordance under test.
    const barPanel = page.locator('#timerbar-start-panel');
    await expect(barPanel.getByLabel('Project', { exact: true })).toBeVisible();
  });

  test('TimerBar reflects a running entry started server-side', async ({ page }) => {
    await signInAs(page, {
      actorKey: 'bob',
      initialRunningEntry: { project_key: 'P1', mood_score: 4 },
    });
    // Scope to the TimerBar's running region (role="status"): the running entry
    // also renders a "Running" status badge in the /timesheets week table, so an
    // unscoped query matches both. The bar is the component under test here.
    const bar = page.getByRole('status').filter({ hasText: 'Running' });
    await expect(bar.getByText('Running')).toBeVisible();
    await expect(bar.getByText(PROJECTS.P1.name)).toBeVisible();
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
    // Toast appears, week status badges flip. The Radix Toast renders its title
    // BOTH as a visible <Title> node AND inside a screen-reader aria-live
    // announcement ("Notification Week submitted…"), so a loose /week submitted/i
    // match trips strict mode (two nodes). Anchor on the exact visible title text
    // so we assert the one visible toast title. (Pre-existing Radix announcement
    // duplication — unrelated to FEAT-001.)
    await expect(page.getByText('Week submitted', { exact: true })).toBeVisible();
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
