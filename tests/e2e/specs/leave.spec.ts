import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

// Hermetic-only: pre-seeds pending leave via mock-state.
test.skip(isLiveMode(), 'hermetic-only — mock-state seeding');

test.describe('Journey 8: employee books leave', () => {
  test('Bob lands on /leave with the empty state when nothing booked', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob', landingPath: '/leave' });
    await expect(page.getByRole('heading', { name: /^leave$/i })).toBeVisible();
    await expect(page.getByText(/no leave requests yet/i)).toBeVisible();
  });

  test('Bob can POST a new leave request via the API (UI modal pending)', async ({ page }) => {
    // The "New leave request" modal is a TODO in the build (see
    // apps/web/app/leave/page.tsx). We post via the browser fetch (with the
    // session cookie) to exercise the contract; once the modal lands the UI
    // form should hit the same endpoint and the test can be widened.
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/leave' });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const start = nextDateString(7);
    const end = nextDateString(11);
    const resp = await page.evaluate(
      async ({ apiBase, start, end }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({
            leave_type: 'annual',
            start_date: start,
            end_date: end,
            note: 'Family holiday',
          }),
        });
        return { status: r.status };
      },
      { apiBase, start, end },
    );
    expect(resp.status).toBe(201);
    expect(handle.state.leaveRequests.size).toBe(1);
    await page.reload();
    // List now shows the pending request.
    await expect(page.getByText('annual').first()).toBeVisible();
    await expect(page.getByText('pending').first()).toBeVisible();
  });
});

test.describe('Journey 9: manager approves leave', () => {
  test('Alice sees Bob\'s pending leave request in /leave/approvals', async ({ page }) => {
    await signInAs(page, {
      actorKey: 'alice',
      landingPath: '/leave/approvals',
      seedPendingLeave: { fromUserKey: 'bob' },
    });
    await expect(page.getByRole('heading', { name: /leave approvals/i })).toBeVisible();
    await expect(page.getByText(USERS.bob.displayName)).toBeVisible();
    await expect(page.getByText('annual')).toBeVisible();
  });

  test('Alice approves Bob\'s leave via API and Bob sees status=approved', async ({ page }) => {
    const handleA = await signInAs(page, {
      actorKey: 'alice',
      landingPath: '/leave/approvals',
      seedPendingLeave: { fromUserKey: 'bob' },
    });
    const leaveId = Array.from(handleA.state.leaveRequests.keys())[0]!;
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase, leaveId }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests/${leaveId}/approve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        return { status: r.status };
      },
      { apiBase, leaveId },
    );
    expect(resp.status).toBe(200);
    expect(handleA.state.leaveRequests.get(leaveId)!.status).toBe('approved');

    // Now sign in as Bob and verify the approved status reflects on his list.
    const handleB = await signInAs(page, { actorKey: 'bob', landingPath: '/leave' });
    handleB.state.leaveRequests.set(leaveId, {
      ...handleA.state.leaveRequests.get(leaveId)!,
    });
    await page.reload();
    await expect(page.getByText('approved')).toBeVisible();
  });

  test('Approve attempt for a user outside Alice\'s scope returns RBAC_FORBIDDEN', async ({
    page,
  }) => {
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/leave/approvals' });
    // Insert a leave from Dave (outside Alice's scope).
    handle.state.leaveRequests.set('leave-dave-1', {
      id: 'leave-dave-1',
      user_id: USERS.dave.id,
      user_name: USERS.dave.displayName,
      leave_type: 'annual',
      start_date: nextDateString(7),
      end_date: nextDateString(11),
      note: null,
      status: 'pending',
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests/leave-dave-1/approve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
  });
});

test.describe('Journey 9b: Leave RBAC role gates (Finding 1)', () => {
  test('Employee Eve cannot approve another user\'s leave — 403 RBAC_FORBIDDEN', async ({
    page,
  }) => {
    // Bob (employee) attempts to approve a peer's leave. The role gate
    // (@Roles('manager','admin','finmgr')) should reject before any scope
    // check fires. We use Bob as the employee actor and seed a leave from
    // Carol so the request targets a real leave id.
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/leave' });
    handle.state.leaveRequests.set('leave-carol-1', {
      id: 'leave-carol-1',
      user_id: USERS.carol.id,
      user_name: USERS.carol.displayName,
      leave_type: 'annual',
      start_date: nextDateString(7),
      end_date: nextDateString(11),
      note: null,
      status: 'pending',
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests/leave-carol-1/approve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
    expect(handle.state.leaveRequests.get('leave-carol-1')!.status).toBe('pending');
  });

  test('Manager Alice approves Bob\'s leave (anchored employee) — 200', async ({ page }) => {
    // This is the happy path: Alice is person-anchored to Bob; her scope
    // includes him; she holds the manager role; she is not the leave owner.
    const handle = await signInAs(page, {
      actorKey: 'alice',
      landingPath: '/leave/approvals',
      seedPendingLeave: { fromUserKey: 'bob' },
    });
    const leaveId = Array.from(handle.state.leaveRequests.keys())[0]!;
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase, leaveId }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests/${leaveId}/approve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase, leaveId },
    );
    expect(resp.status).toBe(200);
    expect(handle.state.leaveRequests.get(leaveId)!.status).toBe('approved');
  });

  test('Manager Alice cannot self-approve her own leave — 403 RBAC_FORBIDDEN', async ({
    page,
  }) => {
    // Even though Alice holds the manager role AND can "see herself" via the
    // scope cascade, the self-approval guard explicitly blocks the action.
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/leave' });
    handle.state.leaveRequests.set('leave-alice-self', {
      id: 'leave-alice-self',
      user_id: USERS.alice.id,
      user_name: USERS.alice.displayName,
      leave_type: 'annual',
      start_date: nextDateString(7),
      end_date: nextDateString(11),
      note: 'Self-approval attempt',
      status: 'pending',
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests/leave-alice-self/approve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
    expect((resp.body as { message: string }).message).toMatch(/self-approve/i);
    expect(handle.state.leaveRequests.get('leave-alice-self')!.status).toBe('pending');
  });

  test('Self-reject is also blocked — 403 RBAC_FORBIDDEN', async ({ page }) => {
    // Symmetric guard on the reject path. Even with a valid >=10-char
    // reason, the actor cannot reject their own leave.
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/leave' });
    handle.state.leaveRequests.set('leave-alice-self-rej', {
      id: 'leave-alice-self-rej',
      user_id: USERS.alice.id,
      user_name: USERS.alice.displayName,
      leave_type: 'annual',
      start_date: nextDateString(7),
      end_date: nextDateString(11),
      note: 'Self-reject attempt',
      status: 'pending',
    });
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/leave/requests/leave-alice-self-rej/reject`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ reason: 'I changed my mind about the dates' }),
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
    expect(handle.state.leaveRequests.get('leave-alice-self-rej')!.status).toBe('pending');
  });
});

function nextDateString(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
