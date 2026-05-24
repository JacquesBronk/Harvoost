/**
 * INC-006 (GitHub issue #7) — LIVE verification that the Admin › Users page
 * (`/admin/users`) renders the user list WITHOUT crashing, now that
 * `GET /v1/users` returns `roles: string[]` per user.
 *
 * PRE-FIX symptom (see incidents/INC-006/REPORT.md): the user-list fetch
 * succeeded (200, after #4's BigInt fix) but the BE list response OMITTED
 * `roles`, while the FE mapped `user.roles.length` / `user.roles.map(...)`
 * UNGUARDED. So every `user.roles` was `undefined` and `.length` threw
 * "TypeError: Cannot read properties of undefined (reading 'length')" inside
 * the row `.map`, crashing the whole route into the React error boundary.
 *
 * THE FIX (two-pronged):
 *   - Backend: `GET /v1/users` list now aggregates `roles` from `user_roles`
 *     (LEFT JOIN + array_agg, mirroring `GET /v1/auth/me`; `[]` if none).
 *   - Frontend: every `user.roles` read is guarded via `(user.roles ?? [])`
 *     (the new `roles-cell.tsx` helper / `roleSet`) so a single drifted row
 *     degrades to "No roles" instead of a hard crash.
 *
 * This spec drives a REAL browser through the real Keycloak handshake against
 * the running docker stack and asserts the four acceptance checks from the
 * dispatch:
 *   1. HEADLINE — `/admin/users` renders the users TABLE (rows visible), with
 *      NO error boundary ("Something went wrong") and NO console TypeError.
 *   2. `GET /v1/users` → 200 (not 500) with a `roles` array on EVERY user, and
 *      known users mapped correctly (admin→[admin], alice→[manager],
 *      finmgr→[finmgr]).
 *   3. Role chips/labels are visible in the rendered rows.
 *   4. The "Edit roles" editor opens SEEDED with the user's CURRENT roles
 *      pre-selected (read-only — we cancel without mutating seed state).
 *
 * Plus LIGHT no-regression checks folded in (INC-002/003 sign-in round-trip &
 * no /login bounce; INC-005 no RATE_LIMITED during an authed admin nav).
 *
 * It follows the live-gated conventions of admin-pages-load.spec.ts:
 *   - whole-file `test.skip(!isLiveMode(), ...)`;
 *   - serial + one-login-per-throttle-window pacing (the AuthController 5/60s
 *     brute-force bucket is shared by oidc/login + oidc/callback + idp-info;
 *     ONE full login spends ~4 slots, so two logins must not coexist in the
 *     same 60s window).
 *
 * Run (against the already-running live docker stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     specs/inc006-admin-users.spec.ts --project=chromium-live --workers=1
 */
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Whole-file gate: live-only — needs a real Keycloak handshake + real backend.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend');

// Serial + one-login-per-window pacing (mirrors admin-pages-load.spec.ts).
test.describe.configure({ mode: 'serial' });

const AUTH_THROTTLE_TTL_MS = 60_000;
const AUTH_GUARD_MS = 20_000;
let lastAuthBudgetSpentAt = Date.now() - AUTH_THROTTLE_TTL_MS - AUTH_GUARD_MS;
function markAuthBudgetSpent(): void {
  lastAuthBudgetSpentAt = Date.now();
}
async function waitForAuthWindow(): Promise<void> {
  const target = lastAuthBudgetSpentAt + AUTH_THROTTLE_TTL_MS + AUTH_GUARD_MS;
  const remaining = target - Date.now();
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

/** A captured `GET /v1/users` list response (parsed body kept for assertions). */
interface UsersListCapture {
  status: number;
  url: string;
  body: { data?: Array<{ email?: string; roles?: unknown }> } | null;
}

/**
 * Record every `GET /v1/users` LIST response (the bare `/v1/users` path, not
 * the per-user `/v1/users/:id...` mutation routes), parsing the JSON body so we
 * can field-check `roles`. Returns a live array mutated as responses arrive.
 */
function trackUsersList(page: Page): UsersListCapture[] {
  const caps: UsersListCapture[] = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!u.startsWith(apiBase)) return;
    if (resp.request().method() !== 'GET') return;
    const path = u.replace(apiBase, '');
    // Match the LIST endpoint: `/v1/users` or `/v1/users?...` — NOT
    // `/v1/users/{id}` (which has a path segment after `users`).
    if (!/^\/v1\/users(\?|$)/.test(path)) return;
    let body: UsersListCapture['body'] = null;
    try {
      body = (await resp.json()) as UsersListCapture['body'];
    } catch {
      body = null;
    }
    caps.push({ status: resp.status(), url: path, body });
  });
  return caps;
}

/** The most recent successfully-parsed list capture, or undefined. */
function latestUsersList(caps: UsersListCapture[]): UsersListCapture | undefined {
  return [...caps].reverse().find((c) => c.body !== null);
}

/** A stable "we are on the authed shell, not the spinner, not /login" marker. */
async function expectAuthedShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
  await expect(page.getByText('Loading Harvoost')).toHaveCount(0);
}

test.describe('INC-006 — Admin › Users page renders roles without crashing (live)', () => {
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + AUTH_GUARD_MS + 5_000);
    await waitForAuthWindow();
    // Anchor the window on THIS test's imminent login.
    markAuthBudgetSpent();
  });

  test(
    'admin: /admin/users renders the table + role chips, GET /v1/users returns roles, role editor seeds current roles',
    async ({ page }) => {
      test.setTimeout(120_000 + AUTH_THROTTLE_TTL_MS);

      // ---- Diagnostics capture --------------------------------------------
      // Collect page errors (uncaught exceptions — the pre-fix TypeError would
      // surface here) and console errors. We assert the specific pre-fix
      // TypeError is ABSENT; other console noise is logged but not failed on.
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));
      page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      const usersCaps = trackUsersList(page);

      // ---- Sign in (real Keycloak) — INC-002/003 round-trip ----------------
      // signInAs lands on /timesheets after a successful code exchange; the
      // helper already asserts we did NOT bounce back to /login.
      await signInAs(page, { actorKey: 'admin' });
      await expectAuthedShell(page);

      // =====================================================================
      // CHECK 1 (HEADLINE) — /admin/users renders the table, no error boundary.
      // =====================================================================
      await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });

      // The page heading renders (we reached the route, not a redirect — admin
      // role grants access; a non-admin would be kicked to /timesheets).
      await expect(
        page.getByRole('heading', { name: 'User management' }),
      ).toBeVisible();

      // The error-boundary / crash UI must be ABSENT. Pre-fix the whole route
      // threw into the boundary ("Something went wrong"). We check both the
      // generic boundary copy and that we are NOT on /timesheets (RBAC kick).
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/timesheets/);

      // The users TABLE renders with its column headers (NOT the ErrorBlock /
      // EmptyState). `getByRole('columnheader')` is the accessible-name-first
      // locator; the table has User / Roles / Timezone / Status / Actions.
      await expect(
        page.getByRole('columnheader', { name: 'User', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('columnheader', { name: 'Roles', exact: true }),
      ).toBeVisible();

      // At least one seeded user ROW is visible (the table is populated, not an
      // empty-state). admin@harvoost.local is always present (we're signed in
      // as them) and so is alice. Cells render the email under the name.
      await expect(
        page.getByRole('cell', { name: /admin@harvoost\.local/ }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole('cell', { name: /alice@harvoost\.local/ }).first(),
      ).toBeVisible();

      // =====================================================================
      // CHECK 2 — GET /v1/users → 200 with a `roles` array on every user, and
      // known users mapped correctly.
      // =====================================================================
      // Wait for the list fetch to have been captured AND parsed.
      await expect
        .poll(() => latestUsersList(usersCaps)?.status, {
          message: 'GET /v1/users list response was captured',
          timeout: 15_000,
        })
        .toBe(200);

      const listCap = latestUsersList(usersCaps)!;
      expect(listCap.status, 'GET /v1/users is 200 (not 500)').toBe(200);
      const rows = listCap.body?.data ?? [];
      expect(rows.length, 'GET /v1/users returns a non-empty user list').toBeGreaterThan(0);

      // EVERY user object carries a `roles` ARRAY (the field is no longer
      // omitted; pre-fix it was `undefined` on every row).
      for (const u of rows) {
        expect(
          Array.isArray(u.roles),
          `every user has a roles[] array — ${u.email} roles=${JSON.stringify(u.roles)}`,
        ).toBe(true);
      }

      // Known seeded users map to the right roles (confirms the array_agg JOIN
      // is correct, not just present). role enum literals: admin/finmgr/
      // manager/employee.
      const byEmail = new Map(rows.map((u) => [u.email, (u.roles as string[]) ?? []]));
      expect(byEmail.get('admin@harvoost.local'), 'admin → [admin]').toEqual(['admin']);
      expect(byEmail.get('alice@harvoost.local'), 'alice → [manager]').toEqual(['manager']);
      expect(byEmail.get('finmgr@harvoost.local'), 'finmgr → [finmgr]').toEqual(['finmgr']);

      // =====================================================================
      // CHECK 3 — Role chips/labels render in the rendered rows.
      // =====================================================================
      // The RolesCell renders a Badge per role. We assert the admin row shows
      // an "admin" chip and alice's row a "manager" chip. The badges are
      // capitalized via CSS (text content is the lowercase role literal), so we
      // match the role text case-insensitively, scoped to the user's row.
      const adminRow = page.getByRole('row', { name: /admin@harvoost\.local/ });
      await expect(adminRow.getByText('admin', { exact: true })).toBeVisible();
      const aliceRow = page.getByRole('row', { name: /alice@harvoost\.local/ });
      await expect(aliceRow.getByText('manager', { exact: true })).toBeVisible();
      // No row degraded to the "No roles" placeholder (every seeded user has
      // ≥1 role; the empty-state is covered hermetically, not live).
      await expect(page.getByText('No roles')).toHaveCount(0);

      // =====================================================================
      // CHECK 4 — "Edit roles" editor opens SEEDED with current roles. (Alice
      // → only `manager` pre-selected.) Read-only: we cancel without saving so
      // seed state is untouched.
      // =====================================================================
      // Click "Edit roles" within alice's row (scoped so we open the right
      // editor — there are many "Edit roles" buttons).
      await aliceRow.getByRole('button', { name: 'Edit roles' }).click();

      const dialog = page.getByRole('dialog');
      await expect(
        dialog.getByText('Edit roles — Alice Manager'),
      ).toBeVisible();

      // The editor seeds `draft: new Set(user.roles)` → `manager` is checked,
      // the other three are NOT. The checkboxes are inside <label> elements
      // whose accessible name is the role literal + its description (the role
      // word is the label's leading span: `admin` / `finmgr` / `manager` /
      // `employee`). We anchor each pattern on that leading literal so the four
      // checkboxes are matched unambiguously (the descriptions never contain a
      // sibling role's literal — "Manages" ≠ "manager").
      const managerCb = dialog.getByRole('checkbox', { name: /^manager\b/i });
      const adminCb = dialog.getByRole('checkbox', { name: /^admin\b/i });
      const finmgrCb = dialog.getByRole('checkbox', { name: /^finmgr\b/i });
      const employeeCb = dialog.getByRole('checkbox', { name: /^employee\b/i });

      await expect(managerCb, "alice's CURRENT role (manager) is pre-checked").toBeChecked();
      await expect(adminCb, 'admin is NOT pre-checked for alice').not.toBeChecked();
      await expect(finmgrCb, 'finmgr is NOT pre-checked for alice').not.toBeChecked();
      await expect(employeeCb, 'employee is NOT pre-checked for alice').not.toBeChecked();

      // Cancel — DO NOT save. Seed state is unchanged (net-zero).
      await dialog.getByRole('button', { name: /cancel/i }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // =====================================================================
      // NO-REGRESSION (light): the pre-fix TypeError must be ABSENT, and no
      // RATE_LIMITED (INC-005) bit us during this authed admin nav.
      // =====================================================================
      const offending = [...pageErrors, ...consoleErrors].filter((m) =>
        /Cannot read properties of undefined \(reading 'length'\)/.test(m) ||
        /user\.roles/.test(m),
      );
      expect(
        offending,
        `no INC-006 roles TypeError surfaced — saw: ${JSON.stringify(offending)}`,
      ).toEqual([]);

      // INC-005: as an authed admin (1000/60s budget) the routine list reads
      // must not be rate-limited. None of the captured /v1/users hits 429'd.
      const rateLimited = usersCaps.filter((c) => c.status === 429);
      expect(
        rateLimited.length,
        'no RATE_LIMITED on /v1/users during authed admin nav (INC-005)',
      ).toBe(0);

      // Still on the authed shell, never crashed across the walk.
      await expectAuthedShell(page);

      // eslint-disable-next-line no-console
      console.log(
        '\n===== INC-006 ADMIN USERS — captured /v1/users =====\n' +
          usersCaps
            .map(
              (c) =>
                `  ${c.status} GET ${c.url}` +
                (c.body?.data
                  ? ` (${c.body.data.length} users; ` +
                    `admin=${JSON.stringify(byEmailRoles(c, 'admin@harvoost.local'))}, ` +
                    `alice=${JSON.stringify(byEmailRoles(c, 'alice@harvoost.local'))}, ` +
                    `finmgr=${JSON.stringify(byEmailRoles(c, 'finmgr@harvoost.local'))})`
                  : ''),
            )
            .join('\n') +
          `\n  pageErrors=${JSON.stringify(pageErrors)}` +
          `\n  consoleErrors(count)=${consoleErrors.length}` +
          '\n====================================================\n',
      );
    },
  );
});

/** Helper for the diagnostic log: pull a user's roles out of a capture. */
function byEmailRoles(cap: UsersListCapture, email: string): unknown {
  return (cap.body?.data ?? []).find((u) => u.email === email)?.roles;
}
