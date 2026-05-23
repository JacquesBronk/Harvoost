import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { PROJECTS } from '../fixtures/rbac.js';

// Hermetic-only: relies on mock-state idempotency map for inspection. The
// live counterpart would query the API's idempotency_keys table.
test.skip(isLiveMode(), 'hermetic-only — mock idempotency map');

test.describe('Journey 11: idempotency — same key replay yields same response', () => {
  test('two POSTs with the same Idempotency-Key create one entry', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const idempKey = 'idem-test-001';

    const first = await page.evaluate(
      async ({ apiBase, idempKey, projectId }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempKey,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase, idempKey, projectId: PROJECTS.P1.id },
    );
    expect(first.status).toBe(201);

    const second = await page.evaluate(
      async ({ apiBase, idempKey, projectId }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempKey,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase, idempKey, projectId: PROJECTS.P1.id },
    );
    expect(second.status).toBe(200);
    // Same entry returned — id stable across replays.
    expect((second.body as { entry: { id: string } }).entry.id).toBe(
      (first.body as { entry: { id: string } }).entry.id,
    );
    // Server has exactly one running entry for this user.
    const running = Array.from(handle.state.entries.values()).filter(
      (e) => e.user_id === handle.state.actor.id && e.status === 'running',
    );
    expect(running.length).toBe(1);
  });

  test('POST start without Idempotency-Key returns 400 VALIDATION_FAILED', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase, projectId }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/start`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ project_id: projectId, mood_score: 4 }),
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase, projectId: PROJECTS.P1.id },
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  test('stop retries with the same key are idempotent', async ({ page }) => {
    const handle = await signInAs(page, {
      actorKey: 'bob',
      landingPath: '/timesheets',
      initialRunningEntry: { project_key: 'P1', mood_score: 4 },
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const idempKey = 'stop-idem-001';
    const first = await page.evaluate(
      async ({ apiBase, idempKey }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/stop`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempKey,
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase, idempKey },
    );
    expect(first.status).toBe(200);
    const second = await page.evaluate(
      async ({ apiBase, idempKey }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/stop`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempKey,
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        return { status: r.status, body: await r.json() };
      },
      { apiBase, idempKey },
    );
    expect(second.status).toBe(200);
    expect((second.body as { entry: { id: string } }).entry.id).toBe(
      (first.body as { entry: { id: string } }).entry.id,
    );
    // No double-stop side effects: still no running timer.
    const running = Array.from(handle.state.entries.values()).filter(
      (e) => e.user_id === handle.state.actor.id && e.status === 'running',
    );
    expect(running.length).toBe(0);
  });
});
