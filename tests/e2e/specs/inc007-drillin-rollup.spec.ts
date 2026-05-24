/**
 * INC-007 (GitHub issue #9) — LIVE verification that the employee/project
 * drill-in pages load their rollup instead of 400'ing.
 *
 * Pre-fix symptom (see incidents/INC-007/REPORT.md): both drill-in pages called
 * their rollup endpoint with NO query string, but the API requires
 * `date_range=YYYY-MM-DD/YYYY-MM-DD` (parseDateRange throws otherwise). So:
 *   - GET /v1/reports/employees/:id/rollup  -> 400 VALIDATION_FAILED
 *   - GET /v1/reports/projects/:id/rollup   -> 400 VALIDATION_FAILED
 * and each page rendered the "Could not load data" ErrorBlock.
 *
 * The frontend-only fix mirrors the #4 dashboard pattern: each page now builds a
 * default `date_range` = current ISO week (Mon->Sun) in the viewer's timezone
 * via `currentIsoWeekRange(zone)` and passes it as the `date_range` query, gated
 * `enabled: !!dateRange`, with the range folded into the React-Query key.
 *
 * This spec drives a REAL browser through the real Keycloak handshake against
 * the running docker stack and asserts, per drill-in page:
 *   - the rollup request carries `?date_range=YYYY-MM-DD/YYYY-MM-DD` (URL-encoded
 *     slash tolerated), and returns 200 (NOT the pre-fix 400), and
 *   - the page renders the rollup (PageHeader + the rollup Card), NOT the
 *     ErrorBlock.
 *
 * It follows the live-gated conventions of admin-pages-load.spec.ts /
 * oidc-flow.spec.ts:
 *   - whole-file `test.skip(!isLiveMode(), ...)`;
 *   - serial + one-login-per-throttle-window pacing (the AuthController 5/60s
 *     brute-force bucket is shared by oidc/login + oidc/callback + idp-info; one
 *     full login spends ~4 slots, so two logins must not fall in the same 60s
 *     window). The rollup GETs are NOT on that bucket, so a SINGLE login can
 *     drive both drill-in pages — this spec therefore uses exactly ONE login.
 *
 * IDs used (discovered from the live seed DB, RBAC-visible to admin who is
 * unrestricted):
 *   - employee userId = 3 (alice@harvoost.local) — has seeded time entries in
 *     the current ISO week, so the rollup renders real per-project rows.
 *   - projectId = 1 (Atlas (hourly)) — the most-logged-against seed project.
 * Admin sees every employee/project, so both drill-ins are in scope.
 *
 * Run (against the already-running live docker stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     specs/inc007-drillin-rollup.spec.ts --project=chromium-live --workers=1
 */
import { expect, test, type Page } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Whole-file gate: live-only — needs a real Keycloak handshake + real backend.
// (The hermetic mock-api ships NO rollup handler, so these drill-in pages are
// not exercised in mocked mode; this spec is the live regression net.)
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend');

test.describe.configure({ mode: 'serial' });

// In-scope ids from the live seed (see header). Admin is RBAC-unrestricted.
const EMPLOYEE_ID = '3'; // alice@harvoost.local — has current-week entries
const PROJECT_ID = '1'; // Atlas (hourly)

// The `date_range` the FE must send: two YYYY-MM-DD bounds joined by '/'. In a
// URL the slash is commonly percent-encoded (%2F); accept either form.
const DATE_RANGE_RE = /date_range=\d{4}-\d{2}-\d{2}(%2F|\/)\d{4}-\d{2}-\d{2}/;

// -----------------------------------------------------------------------------
// One-login-per-throttle-window pacing (mirrors admin-pages-load.spec.ts). The
// 5/60s `auth` brute-force bucket is a fixed window shared by oidc/login +
// oidc/callback + idp-info. We use ONE login total here, but keep the guard so a
// rapid prior run in the same minute can't starve our single login.
// -----------------------------------------------------------------------------
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

interface ApiHit {
  status: number;
  method: string;
  url: string;
  /** Top-level field names of the JSON response body (best-effort). */
  bodyKeys?: string[];
  /** The parsed JSON body (best-effort) — used to confirm nested fields. */
  body?: Record<string, unknown>;
}

/**
 * Record every API-origin response whose path matches one of `needles`. Returns
 * a live array (mutated as responses arrive) so a test can assert AFTER the
 * page-render condition has settled. The API base is stripped so the recorded
 * url is the bare path+query.
 */
function trackApi(page: Page, needles: string[]): ApiHit[] {
  const hits: ApiHit[] = [];
  page.on('response', (resp) => {
    const u = resp.url();
    if (u.startsWith(apiBase) && needles.some((n) => u.includes(n))) {
      const hit: ApiHit = {
        status: resp.status(),
        method: resp.request().method(),
        url: u.replace(apiBase, ''),
      };
      // Best-effort capture of the response body so the spec can confirm the
      // pinned wire shape (top-level + nested field names). Awaiting body() in
      // an event handler is fine: the array is read AFTER the page settles.
      resp
        .json()
        .then((body: unknown) => {
          if (body && typeof body === 'object') {
            hit.body = body as Record<string, unknown>;
            hit.bodyKeys = Object.keys(body as Record<string, unknown>).sort();
          }
        })
        .catch(() => {
          /* non-JSON or already-consumed body — leave bodyKeys undefined */
        });
      hits.push(hit);
    }
  });
  return hits;
}

/** Find the most recent matching hit (method optional). */
function lastHit(hits: ApiHit[], pathIncludes: string, method?: string): ApiHit | undefined {
  return [...hits]
    .reverse()
    .find((h) => h.url.includes(pathIncludes) && (!method || h.method === method));
}

/**
 * Assert that the latest GET to `pathIncludes` is 200, tolerating a TRANSIENT
 * 429 from the per-IP global throttler (300/60s) under load: if the most recent
 * status is 429 we reload the page (React Query refetches) up to `maxReloads`
 * times and re-check. This is condition-based recovery tied to the observed 429
 * — NOT an arbitrary delay — and it can never paper over the pre-fix 400 (a 400
 * never becomes 200 on reload, so a genuinely-broken endpoint still fails the
 * assertion). Lifted from admin-pages-load.spec.ts.
 */
async function expectGetOkTolerateThrottle(
  page: Page,
  hits: ApiHit[],
  pathIncludes: string,
  message: string,
  opts: { maxReloads?: number } = {},
): Promise<void> {
  const maxReloads = opts.maxReloads ?? 6;
  for (let attempt = 0; attempt <= maxReloads; attempt++) {
    const baseline = hits.length;
    const status = await new Promise<number | undefined>((resolve) => {
      const start = Date.now();
      const tick = () => {
        const h =
          attempt === 0
            ? lastHit(hits, pathIncludes, 'GET')
            : [...hits.slice(baseline)]
                .reverse()
                .find((x) => x.url.includes(pathIncludes) && x.method === 'GET');
        if (h && h.status !== 429) return resolve(h.status);
        if (Date.now() - start > 8_000) return resolve(h?.status);
        setTimeout(tick, 200);
      };
      tick();
    });
    if (status === 200) return;
    if ((status === 429 || status === undefined) && attempt < maxReloads) {
      await new Promise((r) => setTimeout(r, 6_000));
      await page.reload({ waitUntil: 'domcontentloaded' });
      continue;
    }
    expect(status, `${message} (last status ${status})`).toBe(200);
    return;
  }
  expect(lastHit(hits, pathIncludes, 'GET')?.status, message).toBe(200);
}

/** A stable "we are on the authed shell, not the spinner, not /login" marker. */
async function expectAuthedShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
  await expect(page.getByText('Loading Harvoost')).toHaveCount(0);
}

/**
 * Assert the drill-in rendered its rollup Card (`cardTitle`) and NO error
 * surface is present. Two error surfaces are possible and both count as a
 * regression of the acceptance criterion ("the page loads the rollup"):
 *   1. the data-layer ErrorBlock — "Could not load data" + a "Retry" button
 *      (rendered when the rollup GET errors, e.g. the pre-fix 400); and
 *   2. the top-level error boundary — "Something went wrong" + a "Try again"
 *      button (rendered when the render itself throws, e.g. `.map()` of an
 *      undefined field — the contract-drift crash this fix uncovered).
 *
 * Locator note: the rollup Card title (`Card title="Per project"|"Members"`,
 * packages/ui/src/components/Card.tsx) renders as a styled <div>, NOT a
 * semantic heading — so role=heading does not match it (only the PageHeader
 * <h1> is a heading). We therefore anchor on the card title TEXT (the next-best
 * locator when no accessible role exists) AND assert a real data ROW rendered
 * (`rowContains`). The row assertion is the strongest proof the contract-drift
 * crash is gone: the row only exists if `hours_by_project`/`hours_by_member`
 * mapped successfully (an undefined `.map()` would have thrown into the error
 * boundary before any row rendered).
 */
async function expectRollupRendered(
  page: Page,
  cardTitle: string,
  message: string,
): Promise<void> {
  const main = page.getByRole('main');
  const title = main.getByText(cardTitle, { exact: true });
  // A rendered data row: the rollup cards render their hours_by_* arrays as <li>
  // rows. At least one listitem is the strongest proof the contract-drift crash
  // is gone — the row only exists if `hours_by_project`/`hours_by_member` mapped
  // successfully (an undefined `.map()` would have thrown into the error
  // boundary before any row rendered). Seed-independent (no hardcoded names).
  const row = main.getByRole('listitem');
  const errorBlock = page.getByText(/could not load data/i);
  const errorBoundary = page.getByText(/something went wrong/i);
  // Wait for the page to settle into ONE of the observable end-states (a
  // rendered data row or either error surface) — a condition, not a delay.
  await Promise.race([
    row.first().waitFor({ state: 'visible' }).catch(() => null),
    errorBlock.waitFor({ state: 'visible' }).catch(() => null),
    errorBoundary.waitFor({ state: 'visible' }).catch(() => null),
  ]);
  await expect(errorBlock, `${message} [ErrorBlock present]`).toHaveCount(0);
  await expect(errorBoundary, `${message} [error boundary present]`).toHaveCount(0);
  await expect(page.getByRole('button', { name: /retry|try again/i }), `${message} [retry affordance present]`).toHaveCount(0);
  await expect(title, `${message} [card title "${cardTitle}" not rendered]`).toBeVisible();
  await expect(
    row.first(),
    `${message} [no rollup list row rendered — hours_by_* map() produced no content]`,
  ).toBeVisible();
}

test.describe('INC-007 — drill-in rollup pages send a default date_range (live)', () => {
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + AUTH_GUARD_MS + 5_000);
    await waitForAuthWindow();
    markAuthBudgetSpent();
  });

  /**
   * Assert the rollup REQUEST contract for one drill-in: the page fired the
   * rollup GET with a well-formed default `date_range` and it returned 200. This
   * is the INC-007 fix proper (pre-fix this GET had NO date_range and 400'd) and
   * it PASSES with the hotfix. Returns the recorded hit for further sanity.
   */
  async function assertRollupRequestContract(
    page: Page,
    hits: ApiHit[],
    rollupPath: string,
  ): Promise<ApiHit> {
    await expectGetOkTolerateThrottle(
      page,
      hits,
      rollupPath,
      `GET ${rollupPath} returns 200 (was 400 pre-fix — missing date_range)`,
    );
    const hit = lastHit(hits, rollupPath, 'GET')!;
    expect(
      hit.url,
      `rollup must send a date_range=YYYY-MM-DD/YYYY-MM-DD param (got "${hit.url}")`,
    ).toMatch(DATE_RANGE_RE);
    return hit;
  }

  /** Assert a captured date_range is the current ISO week (Mon..Sun inclusive). */
  function assertIsoWeek(hit: ApiHit): void {
    const sent = decodeURIComponent(hit.url.split('date_range=')[1]?.split('&')[0] ?? '');
    const [from, to] = sent.split('/');
    expect(from, 'date_range has a from bound').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to, 'date_range has a to bound').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    const dayMs = 24 * 60 * 60 * 1000;
    expect(
      Math.round((toDate.getTime() - fromDate.getTime()) / dayMs),
      `ISO week spans 6 days (Mon->Sun): ${from}..${to}`,
    ).toBe(6);
    expect(fromDate.getUTCDay(), `from (${from}) is a Monday`).toBe(1); // Mon=1
    expect(toDate.getUTCDay(), `to (${to}) is a Sunday`).toBe(0); // Sun=0
  }

  test('admin: employee + project drill-ins send a default date_range and the rollup GET returns 200 (INC-007 fix)', async ({
    page,
  }) => {
    test.setTimeout(120_000 + AUTH_THROTTLE_TTL_MS);

    const empPath = `/v1/reports/employees/${EMPLOYEE_ID}/rollup`;
    const projPath = `/v1/reports/projects/${PROJECT_ID}/rollup`;
    const hits = trackApi(page, [empPath, projPath]);

    // Single real Keycloak handshake as admin (RBAC-unrestricted, sees all).
    // This also exercises the no-regression INC-002/003 path: sign-in works and
    // /me 200s (signInAs lands on the authed shell, no /login bounce).
    await signInAs(page, { actorKey: 'admin' });
    await expectAuthedShell(page);

    // CHECK 1 (HEADLINE) — employee drill-in rollup request contract.
    let empHit!: ApiHit;
    await test.step('employee drill-in: rollup GET carries date_range and returns 200', async () => {
      await page.goto(`/dashboard/employees/${EMPLOYEE_ID}`, { waitUntil: 'domcontentloaded' });
      empHit = await assertRollupRequestContract(page, hits, empPath);
    });

    // CHECK 2 — project drill-in rollup request contract.
    let projHit!: ApiHit;
    await test.step('project drill-in: rollup GET carries date_range and returns 200', async () => {
      await page.goto(`/dashboard/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
      projHit = await assertRollupRequestContract(page, hits, projPath);
    });

    // CHECK 3 — default-range sanity: the date_range is the current ISO week
    // (Mon..Sun) in the viewer TZ (en-GB / Africa/Johannesburg per the config).
    await test.step('default date_range is the current ISO week (Mon..Sun)', () => {
      assertIsoWeek(empHit);
      assertIsoWeek(projHit);
    });

    // CHECK 4 — PINNED WIRE SHAPE: confirm the reconciled rollup contract on the
    // wire (post-expansion). This is the shape the FE was reconciled to and the
    // OpenAPI/@harvoost/contract field-checks. Captured live, logged for the
    // handoff. Employee: nested `user`, `hours_by_project[]` (REAL in-scope only),
    // top-level `out_of_scope_project_count` + `out_of_scope_hours`. Project:
    // nested `project`, top-level `total_hours` + `billable_hours`,
    // `hours_by_member[]`.
    await test.step('pinned wire shape: employee + project rollup field names match the reconciled contract', () => {
      // eslint-disable-next-line no-console
      console.log('[INC-007 wire] employee rollup body keys:', empHit.bodyKeys);
      // eslint-disable-next-line no-console
      console.log('[INC-007 wire] project  rollup body keys:', projHit.bodyKeys);

      // --- Employee rollup ---
      const emp = empHit.body ?? {};
      expect(emp, 'employee rollup body captured').toBeTruthy();
      expect(emp).toHaveProperty('user');
      expect(emp.user, 'employee.user is an object with display_name').toMatchObject({
        display_name: expect.any(String),
      });
      expect(Array.isArray(emp.hours_by_project), 'employee.hours_by_project is an array').toBe(
        true,
      );
      expect(emp, 'employee has top-level out_of_scope_project_count').toHaveProperty(
        'out_of_scope_project_count',
      );
      expect(emp, 'employee has top-level out_of_scope_hours').toHaveProperty(
        'out_of_scope_hours',
      );
      // Drift guard: the OLD flat fields the pre-expansion FE crashed on must NOT
      // be the source of truth (no top-level `per_project` / `display_name`).
      expect(emp, 'employee NO longer exposes flat per_project').not.toHaveProperty('per_project');

      // --- Project rollup ---
      const proj = projHit.body ?? {};
      expect(proj, 'project rollup body captured').toBeTruthy();
      expect(proj).toHaveProperty('project');
      expect(proj.project, 'project.project is an object with name').toMatchObject({
        name: expect.any(String),
      });
      expect(proj, 'project has top-level total_hours').toHaveProperty('total_hours');
      expect(proj, 'project has top-level billable_hours').toHaveProperty('billable_hours');
      expect(Array.isArray(proj.hours_by_member), 'project.hours_by_member is an array').toBe(
        true,
      );
      // Drift guard: the OLD flat fields must NOT be the contract anymore.
      expect(proj, 'project NO longer exposes flat members[]').not.toHaveProperty('members');
    });
  });

  /**
   * End-to-end render (acceptance #1/#2 of issue #9): with the rollup 200 AND the
   * FE reconciled to the pinned contract (the approved expansion), the page must
   * RENDER the rollup with NO error surface.
   *
   * HISTORY: this assertion was KNOWN-RED in the first INC-007 run — the rollup
   * GET was 200, but a separate FE↔API contract drift the date_range fix uncovered
   * made the render throw "Cannot read properties of undefined (reading 'map')"
   * (the FE read `per_project` / `members` while the API returned `hours_by_project`
   * / `hours_by_member`). The expansion reshaped both rollups to a pinned contract
   * and reconciled the drill-in pages to it (employee reads `user.display_name` +
   * `hours_by_project` + `out_of_scope_*`; project reads `project.name` +
   * `hours_by_member` + `project.hours_budget`). This test is now a NORMAL PASS
   * assertion and stands as the durable regression net for that reconciliation.
   */
  test('admin: employee + project drill-ins RENDER the rollup with no error surface (acceptance #1/#2)', async ({
    page,
  }) => {
    test.setTimeout(120_000 + AUTH_THROTTLE_TTL_MS);

    await signInAs(page, { actorKey: 'admin' });
    await expectAuthedShell(page);

    await page.goto(`/dashboard/employees/${EMPLOYEE_ID}`, { waitUntil: 'domcontentloaded' });
    await expectRollupRendered(
      page,
      'Per project',
      'employee drill-in renders the rollup (no error surface). EXPECT-GREEN post-' +
        'expansion: FE reads `user.display_name` + `hours_by_project[]` + ' +
        '`out_of_scope_project_count`/`out_of_scope_hours` from the pinned contract.',
    );

    await page.goto(`/dashboard/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
    await expectRollupRendered(
      page,
      'Members',
      'project drill-in renders the rollup (no error surface). EXPECT-GREEN post-' +
        'expansion: FE reads `project.name` + `total_hours`/`billable_hours` + ' +
        '`hours_by_member[]` from the pinned contract.',
    );
  });
});
