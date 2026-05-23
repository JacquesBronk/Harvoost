/**
 * Exceptions RBAC (Finding 2 — v1 self-resolve only).
 *
 * Per the FIX_PLAN: PATCH /v1/exceptions/:id/resolve is now self-resolve-only.
 * Even managers and admins are blocked unless they are the exception owner.
 * REQUIREMENTS § F8.1: "Employees can resolve a missed-punch by creating a
 * manual entry". Self-resolve is the safer v1 default.
 */
import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Hermetic-only: pre-seeds exceptions via mock-state.
test.skip(isLiveMode(), 'hermetic-only — mock-state seeding');

test.describe('Journey 14: exception self-resolve (Finding 2)', () => {
  test('Bob resolves his own missed-punch exception — 200', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/exceptions' });
    const excId = 'exc-bob-1';
    handle.state.exceptions.set(excId, {
      id: excId,
      user_id: USERS.bob.id,
      type: 'MISSED_PUNCH',
      occurred_on: '2026-05-21',
      status: 'open',
    });
    const resp = await page.evaluate(
      async ({ apiBase, excId }) => {
        const r = await fetch(`${apiBase}/v1/exceptions/${excId}/resolve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase, excId },
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { status: string }).status).toBe('resolved');
    const stored = handle.state.exceptions.get(excId)!;
    expect(stored.status).toBe('resolved');
    expect(stored.resolved_by).toBe(USERS.bob.id);
  });

  test('Bob cannot resolve Dave\'s exception — 403 RBAC_FORBIDDEN', async ({ page }) => {
    // Even though Bob and Dave may share a project (P2), the resolve action
    // is self-only. The fact that Bob can SEE Dave's exception is irrelevant.
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/exceptions' });
    const excId = 'exc-dave-1';
    handle.state.exceptions.set(excId, {
      id: excId,
      user_id: USERS.dave.id,
      type: 'OVERTIME_DAY',
      occurred_on: '2026-05-20',
      status: 'open',
    });
    const resp = await page.evaluate(
      async ({ apiBase, excId }) => {
        const r = await fetch(`${apiBase}/v1/exceptions/${excId}/resolve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase, excId },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
    // Server state must be unchanged.
    expect(handle.state.exceptions.get(excId)!.status).toBe('open');
  });

  test('Manager Alice cannot resolve Bob\'s exception (v1 self-resolve only) — 403', async ({
    page,
  }) => {
    // Per FIX_PLAN Finding 2: managers are explicitly NOT given the resolve
    // capability in v1, even when scoped to the target user. This locks down
    // the missed-punch-hiding attack vector.
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/exceptions' });
    const excId = 'exc-bob-mgr';
    handle.state.exceptions.set(excId, {
      id: excId,
      user_id: USERS.bob.id,
      type: 'MISSED_PUNCH',
      occurred_on: '2026-05-20',
      status: 'open',
    });
    const resp = await page.evaluate(
      async ({ apiBase, excId }) => {
        const r = await fetch(`${apiBase}/v1/exceptions/${excId}/resolve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase, excId },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
    expect(handle.state.exceptions.get(excId)!.status).toBe('open');
  });

  test('Admin also cannot resolve another user\'s exception (self-resolve really means self)', async ({
    page,
  }) => {
    // Admins have unrestricted READ access, but the resolve action is
    // intentionally locked to the owner regardless of role. This makes the
    // missed-punch chain tamper-evident: only the user who SHOULD know about
    // their own punch can clear the flag.
    const handle = await signInAs(page, { actorKey: 'admin', landingPath: '/exceptions' });
    const excId = 'exc-bob-admin';
    handle.state.exceptions.set(excId, {
      id: excId,
      user_id: USERS.bob.id,
      type: 'MISSED_PUNCH',
      occurred_on: '2026-05-20',
      status: 'open',
    });
    const resp = await page.evaluate(
      async ({ apiBase, excId }) => {
        const r = await fetch(`${apiBase}/v1/exceptions/${excId}/resolve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase, excId },
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { code: string }).code).toBe('RBAC_FORBIDDEN');
    void handle;
  });

  test('resolving a missing exception id returns 404 NOT_FOUND', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob', landingPath: '/exceptions' });
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/exceptions/does-not-exist/resolve`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const body = await r.json();
        return { status: r.status, body };
      },
      { apiBase },
    );
    expect(resp.status).toBe(404);
    expect((resp.body as { code: string }).code).toBe('NOT_FOUND');
  });
});
