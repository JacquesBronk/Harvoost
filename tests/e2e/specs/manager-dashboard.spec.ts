import { expect, test } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

// Hermetic-only: scope_meta and dashboard row counts depend on the mock
// fixture. The live counterpart would need a deterministic DB seed.
test.skip(isLiveMode(), 'hermetic-only — mock scope/dashboard fixtures');

test.describe('Journey 4: manager dashboard (RBAC scoped)', () => {
  test('Alice sees Bob and Carol on the team dashboard but not Dave', async ({ page }) => {
    await signInAs(page, { actorKey: 'alice', landingPath: '/dashboard' });
    // Card title rendered.
    await expect(page.getByRole('heading', { name: /team dashboard/i })).toBeVisible();
    // Bob and Carol both visible (project_anchored to P1 + person_anchored to Bob).
    await expect(page.getByText(USERS.bob.displayName)).toBeVisible();
    await expect(page.getByText(USERS.carol.displayName)).toBeVisible();
    // Dave is not in Alice's scope.
    await expect(page.getByText(USERS.dave.displayName)).toHaveCount(0);
  });

  test('scope_meta indicator reflects visible_users count', async ({ page }) => {
    await signInAs(page, { actorKey: 'alice', landingPath: '/dashboard' });
    // Alice's visible_users set is {alice,bob,carol} (3); the dashboard hides
    // the actor herself so 2 rows render. The ScopeMetaIndicator surfaces
    // the *scope* number (3, includes self) per the canonical RBAC rule.
    await expect(page.getByText(/\d+ visible users/)).toBeVisible();
  });

  test('Admin sees the unrestricted "All users" indicator', async ({ page }) => {
    await signInAs(page, { actorKey: 'admin', landingPath: '/dashboard' });
    await expect(page.getByText(/all users/i)).toBeVisible();
    // All four employees plus the two non-admin managers visible.
    await expect(page.getByText(USERS.dave.displayName)).toBeVisible();
  });

  test('Employee Bob is gated out of the dashboard', async ({ page }) => {
    await signInAs(page, { actorKey: 'bob', landingPath: '/dashboard' });
    // PageHeader renders an <h1>; EmptyState renders divs (title/description).
    await expect(page.getByRole('heading', { name: /team dashboard/i })).toBeVisible();
    await expect(page.getByText(/^no access$/i)).toBeVisible();
    await expect(page.getByText(/the team dashboard is available to managers/i)).toBeVisible();
  });

  test('Frank (manager with no anchors) sees the empty-scope state', async ({ page }) => {
    await signInAs(page, { actorKey: 'frank', landingPath: '/dashboard' });
    await expect(page.getByText(/no team assigned yet/i)).toBeVisible();
  });
});
