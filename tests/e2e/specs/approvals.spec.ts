import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

// Hermetic-only: mock-state seeding via `handle.state.entries.set(...)`.
test.skip(isLiveMode(), 'hermetic-only — mock-state seeding');

test.describe('Journey 5: manager stage-1 approval', () => {
  test('approvals inbox lists Bob\'s submitted week to Alice', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/approvals' });
    // Seed a submitted entry from Bob.
    handle.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'submitted',
      billable: true,
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: /approvals/i }).first()).toBeVisible();
    await expect(page.getByText(USERS.bob.displayName)).toBeVisible();
    await expect(page.getByText('Submitted')).toBeVisible();
  });

  test('approving the week transitions entries to manager_approved (via API)', async ({
    page,
  }) => {
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/approvals' });
    handle.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'submitted',
      billable: true,
    });
    // The frontend's batch approve UI is a TODO in the build (see
    // apps/web/app/approvals/page.tsx). We exercise the API contract
    // directly so the journey can complete and stage-2 can be tested.
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    await page.evaluate(
      async ({ apiBase }) => {
        await fetch(`${apiBase}/v1/approvals/timesheets/manager`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ entry_ids: ['e1'], action: 'approve' }),
        });
      },
      { apiBase },
    );
    expect(handle.state.entries.get('e1')!.status).toBe('manager_approved');
    expect(handle.state.stage1Approvers.get('e1')).toBe(handle.state.actor.id);
  });

  test('rejecting requires a reason ≥10 chars', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/approvals' });
    handle.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'submitted',
      billable: true,
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const short = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/approvals/timesheets/manager`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ entry_ids: ['e1'], action: 'reject', reason: 'too short' }),
        });
        return { status: r.status };
      },
      { apiBase },
    );
    expect(short.status).toBe(400);
    expect(handle.state.entries.get('e1')!.status).toBe('submitted'); // unchanged
  });
});

test.describe('Journey 6: stage-2 final approval + two-stage invariant', () => {
  test('FinMgr can stage-2 approve an entry stage-1-approved by Alice', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'finmgr', landingPath: '/approvals/final' });
    handle.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'manager_approved',
      billable: true,
    });
    handle.state.stage1Approvers.set('e1', USERS.alice.id);
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/approvals/timesheets/final`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ entry_ids: ['e1'], action: 'approve' }),
        });
        return { status: r.status };
      },
      { apiBase },
    );
    expect(resp.status).toBe(200);
    expect(handle.state.entries.get('e1')!.status).toBe('final_approved');
  });

  test('a dual-role user cannot self-approve at stage 2 (stage1 ≠ stage2 invariant)', async ({
    page,
  }) => {
    // Sign in as a single user holding both manager + finmgr roles. Use
    // a one-off override on the actor's roles.
    const handle = await signInAs(page, {
      actorKey: 'admin',
      landingPath: '/approvals/final',
    });
    // Simulate: stage-1 approval was performed by THIS same admin actor.
    handle.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'manager_approved',
      billable: true,
    });
    handle.state.stage1Approvers.set('e1', handle.state.actor.id);

    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/approvals/timesheets/final`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ entry_ids: ['e1'], action: 'approve' }),
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { message: string }).message).toMatch(/stage-2 approver must be different/i);
    expect(handle.state.entries.get('e1')!.status).toBe('manager_approved'); // unchanged
  });

  test('after final approval, employee edits are locked', async ({ page }) => {
    // FinMgr approves Bob's entry.
    const handleFin = await signInAs(page, { actorKey: 'finmgr', landingPath: '/timesheets' });
    handleFin.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'final_approved',
      billable: true,
    });
    // Switch context: sign back in as Bob.
    const handleBob = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    handleBob.state.entries.set('e1', {
      id: 'e1',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 38.5,
      status: 'final_approved',
      billable: true,
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/time-entries/e1`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ notes: 'attempt to edit final-approved entry' }),
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { code: string }).code).toBe('ENTRY_LOCKED');
  });
});
