import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

// Hermetic-only: seeds a cost-bearing entry via mock-state.
test.skip(isLiveMode(), 'hermetic-only — mock-state seeding');

test.describe('Journey 12: cost-column stripping by role', () => {
  function seedCostEntry(handle: any) {
    handle.state.entries.set('e-cost', {
      id: 'e-cost',
      user_id: USERS.bob.id,
      project_id: '101',
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      hours: 8,
      status: 'draft',
      billable: true,
      cost_rate: 350,
      cost_amount: 2800,
      billable_rate: 1100,
      billable_amount: 8800,
    });
  }

  test('Manager (Alice) detailed-activity response OMITS cost_rate / cost_amount', async ({
    page,
  }) => {
    const handle = await signInAs(page, { actorKey: 'alice', landingPath: '/dashboard' });
    seedCostEntry(handle);
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/reports/detailed-activity`, {
          credentials: 'include',
        });
        return await r.json();
      },
      { apiBase },
    );
    const row = (resp as { items: Array<Record<string, unknown>> }).items[0]!;
    // Absence — not null-zeroed — per Finding category in tester's report.
    expect(row).not.toHaveProperty('cost_rate');
    expect(row).not.toHaveProperty('cost_amount');
    expect(row).not.toHaveProperty('billable_rate');
    expect(row).not.toHaveProperty('billable_amount');
  });

  test('Employee (Bob) detailed-activity response OMITS cost fields too', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'bob', landingPath: '/timesheets' });
    seedCostEntry(handle);
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/reports/detailed-activity`, {
          credentials: 'include',
        });
        return await r.json();
      },
      { apiBase },
    );
    const row = (resp as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(row).not.toHaveProperty('cost_rate');
    expect(row).not.toHaveProperty('cost_amount');
  });

  test('FinMgr detailed-activity response INCLUDES cost fields', async ({ page }) => {
    const handle = await signInAs(page, { actorKey: 'finmgr', landingPath: '/timesheets' });
    seedCostEntry(handle);
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
    const resp = await page.evaluate(
      async ({ apiBase }) => {
        const r = await fetch(`${apiBase}/v1/reports/detailed-activity`, {
          credentials: 'include',
        });
        return await r.json();
      },
      { apiBase },
    );
    const row = (resp as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(row).toHaveProperty('cost_rate');
    expect(row).toHaveProperty('cost_amount');
    expect(row.cost_rate).toBe(350);
  });

  test('Manager nav hides /financial and /admin/rates links', async ({ page }) => {
    await signInAs(page, { actorKey: 'alice', landingPath: '/timesheets' });
    await expect(page.getByRole('link', { name: 'Financial' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Rates' })).toHaveCount(0);
  });

  test('FinMgr nav shows /financial AND /admin/rates links', async ({ page }) => {
    await signInAs(page, { actorKey: 'finmgr', landingPath: '/timesheets' });
    await expect(page.getByRole('link', { name: 'Financial' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Rates' })).toBeVisible();
  });
});
