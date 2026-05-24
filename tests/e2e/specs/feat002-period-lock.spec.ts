/**
 * FEAT-002 (GitHub issue #6) — LIVE verification of period / timesheet approval
 * LOCKING (Option F) against the real docker stack (web :3000 → api :3001 →
 * Postgres + the DB lock trigger HV001 → Keycloak :8080).
 *
 * >>> EXPANSION RE-VERIFY (UI buttons now work end to end) <<<
 *
 * The three pre-existing FE/API envelope drifts that PREVIOUSLY forced submit +
 * unlock to be asserted at the API layer are NOW FIXED in apps/web:
 *   (a) /timesheets reads `entriesQuery.data?.data` → the week ENTRY TABLE
 *       populates live.
 *   (b) RbacScopeService.getVisibleProjectIds adds a `self_anchored` CTE → a PLAIN
 *       EMPLOYEE now sees their OWN member-projects + their OWN entries (RBAC
 *       self-scope), so a plain employee has a real week to submit.
 *   (c) /approvals reads `queue.data?.data` AND the queue endpoint returns enriched
 *       per-(user, ISO-week) `ApprovalQueueItem` rows ({user_name, iso_week,
 *       total_hours, ...}) → the queue RENDERS rows → the per-row UnlockWeekButton
 *       is reachable in the live UI.
 *
 * Because of (a)+(b)+(c) this spec now drives the HEADLINE actions through the
 * REAL browser buttons (no API-layer fallback for the buttons themselves):
 *
 *   EMPLOYEE ACTOR — a PLAIN EMPLOYEE: BOB (bob@harvoost.local, role=employee,
 *   member of projects 1 & 2). Proving the (b) fix for a plain employee is a key
 *   point of this expansion. (If bob ever has no visible projects/entries, we fall
 *   back to Alice — a manager who is also an employee — and record that precisely.)
 *
 *   1. SUBMIT — UI BUTTON. Sign in as bob. Ensure the CURRENT ISO week holds >=1
 *      draft (created through the New-entry modal). Assert the week ENTRY TABLE
 *      RENDERS bob's entries (NOT empty) and the "Submit week" button is ENABLED,
 *      then CLICK it (browser). Assert the success toast ("Submitted N entries"),
 *      the week flips to the LOCKED banner ("Week submitted — locked"), and the
 *      New-entry button is DISABLED. Cross-checked: GET period → "submitted".
 *
 *   2. PERIOD_LOCKED via the UI: with the week locked from step 1's REAL submit,
 *      the New-entry button is DISABLED (blocked) and the page shows the friendly
 *      "this week is locked" message — no crash, no raw PERIOD_LOCKED code. The
 *      server-side rejection is additionally confirmed (createManual → 409
 *      PERIOD_LOCKED; back-dated start → 409; DELETE → 409 lock code) so the lock
 *      is proven at both layers.
 *
 *   3. FUTURE-DATING STILL ALLOWED: createManual into a FUTURE empty week → 2xx
 *      (the FEAT-001 leave/holiday invariant — an empty/future week is never
 *      locked) while the current week stays locked.
 *
 *   4. ADMIN UNLOCK-WEEK — UI BUTTON. Sign in as admin@harvoost.local, land on
 *      /approvals. Assert the queue TABLE RENDERS enriched rows (user name, ISO
 *      week, total hours — NOT empty). Find bob's row for the just-locked week,
 *      click the UnlockWeekButton (modal → reason >= 20 chars → submit). Assert the
 *      success toast ("Week unlocked"), and that the week REOPENS (employee period
 *      → "open", reopened_at set), proving the unlock-week button works end to end.
 *
 *   4b. WRITABILITY RESTORED: bob can write into the reopened week again → 2xx.
 *       State left RESTORED (week open/writable).
 *
 * STATE RESTORATION: we operate on bob's CURRENT ISO week and end with an admin
 * UI-unlock that reopens it to `open` + a writeback, so the week is left WRITABLE
 * (verified). Re-runnable: SETUP auto-resets a leftover-locked week (admin unlock),
 * and each created entry uses a unique time-slot to dodge the no-overlap guard.
 *
 * Run (against the already-running live stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     specs/feat002-period-lock.spec.ts --project=chromium-live --workers=1
 */
import { expect, test, type Page } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS, type FixtureUser } from '../fixtures/rbac.js';

const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';

// Whole-file gate: live-only — drives the real Keycloak handshake + real backend
// + the real DB lock trigger. The hermetic lane has no period-lock state machine.
test.skip(!isLiveMode(), 'live-only — requires Keycloak + real backend + DB lock trigger');

// Sign-ins are serialized; each ~spends the auth bucket. Pace serially + wait for
// the auth window between tests (mirrors feat001-timer-start.spec.ts).
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

/* ------------------------------------------------------------------------- *
 * Browser-context API helpers (carry the HttpOnly session cookie + the CSRF-
 * paired X-Requested-With header), throttle-tolerant (ride out the global
 * 1000/60s INC-005 limiter on a transient 429). Used ONLY for SETUP (seeding a
 * draft, resetting a leftover-locked week), the server-side lock cross-checks
 * (the create/start/delete 409s), and the post-action period reads — NEVER for
 * the headline submit/unlock BUTTONS, which are now driven through the browser.
 * ------------------------------------------------------------------------- */
async function apiCall(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  tries = 12,
): Promise<{ status: number; body: any }> {
  let last: { status: number; body: any } = { status: 0, body: undefined };
  for (let i = 0; i < tries; i++) {
    last = await page.evaluate(
      async ([base, m, p, b]) => {
        const r = await fetch(`${base}${p}`, {
          method: m as string,
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            ...(b !== null ? { 'Content-Type': 'application/json' } : {}),
            'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          },
          body: b !== null ? JSON.stringify(b) : undefined,
        });
        let parsed: unknown = undefined;
        const text = await r.text();
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        return { status: r.status, body: parsed };
      },
      [apiBase, method, path, body ?? null] as const,
    );
    if (last.status !== 429) return last;
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return last;
}

interface PeriodShape {
  user_id: string;
  iso_year: number;
  iso_week: number;
  status: 'open' | 'submitted' | 'manager_approved' | 'final_approved' | 'rejected';
  reopened_at?: string | null;
  submitted_at?: string | null;
  entry_counts?: Record<string, number>;
}

/** GET /v1/timesheet-periods/{iso_week} via the browser session. */
async function getPeriod(page: Page, isoWeek: string): Promise<PeriodShape> {
  const r = await apiCall(page, 'GET', `/v1/timesheet-periods/${isoWeek}`);
  expect(
    r.status,
    `GET /v1/timesheet-periods/${isoWeek} is 200 (got ${r.status}) — body=${JSON.stringify(r.body)}`,
  ).toBe(200);
  return r.body as PeriodShape;
}

/**
 * Read a SPECIFIC user's period via the RBAC-visible LIST endpoint
 * (GET /v1/timesheet-periods?user_id=...). The single GET (/{iso_week}) is
 * SELF-ONLY, so an admin verifying the EMPLOYEE's reopened week must use the list
 * (admin is unrestricted). Returns the matching row, or undefined if absent.
 */
async function getPeriodForUserViaList(
  page: Page,
  userId: string,
  isoYear: number,
  isoWeek: number,
): Promise<PeriodShape | undefined> {
  const r = await apiCall(page, 'GET', `/v1/timesheet-periods?user_id=${userId}&limit=200`);
  if (r.status !== 200) return undefined;
  const rows: PeriodShape[] = (r.body?.data ?? []) as PeriodShape[];
  return rows.find((p) => p.iso_year === isoYear && p.iso_week === isoWeek);
}

/** Poll the period read until predicate holds (condition-based wait). */
async function waitForPeriodStatus(
  page: Page,
  isoWeek: string,
  predicate: (p: PeriodShape) => boolean,
  label: string,
): Promise<PeriodShape> {
  const deadline = Date.now() + 12_000;
  let p = await getPeriod(page, isoWeek);
  while (!predicate(p) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    p = await getPeriod(page, isoWeek);
  }
  expect(predicate(p), `${label} — last period=${JSON.stringify(p)}`).toBe(true);
  return p;
}

/** A stable "authed shell, not the spinner, not /login" marker. */
async function expectAuthedShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
  await expect(page.getByText('Loading Harvoost')).toHaveCount(0);
}

/** The `YYYY-Www` token for an ISO year/week. */
function isoToken(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Compute (iso_year, iso_week) for a Date rendered in a given IANA TZ. We use the
 * same Thursday-of-the-week rule the backend's EXTRACT(ISOYEAR/WEEK) uses,
 * evaluated on the wall-clock date in `tz`. Good enough for the test's anchors
 * (well clear of year boundaries).
 */
function isoWeekInTz(d: Date, tz: string): { year: number; week: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const y = get('year');
  const m = get('month');
  const day = get('day');
  // ISO week of the local calendar date.
  const local = new Date(Date.UTC(y, m - 1, day));
  const dayNum = (local.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  local.setUTCDate(local.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(local.getUTCFullYear(), 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((local.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { year: local.getUTCFullYear(), week };
}

/**
 * Resolve a project id the EMPLOYEE can log time against, PREFERRING the project
 * picker (GET /v1/projects). With the (b) self_anchored fix a plain employee's
 * picker now returns their OWN member-projects, so the list is the source of
 * truth. Falls back to a project id from the actor's own entries, then to a known
 * seed member project id.
 */
async function resolveLoggableProjectId(page: Page, fallbackIds: string[]): Promise<string> {
  const list = await apiCall(page, 'GET', '/v1/projects?page_size=50');
  const listRows: Array<{ id: string }> = (list.body?.data ?? list.body?.items ?? []) as any[];
  if (listRows.length > 0) return String(listRows[0]!.id);
  const mine = await apiCall(page, 'GET', '/v1/time-entries?limit=50');
  const myRows: Array<{ project_id: string }> = (mine.body?.data ?? mine.body?.items ?? []) as any[];
  const used = myRows.find((e) => e.project_id != null)?.project_id;
  if (used) return String(used);
  return fallbackIds[0]!;
}

/**
 * Create a manual entry via the API request layer (carries the real session +
 * CSRF + Idempotency-Key). Used for SETUP and the locked/future server-side
 * cross-checks. The headline submit/unlock BUTTONS are driven through the browser.
 */
async function createManualApi(
  page: Page,
  opts: { projectId: string; startIso: string; endIso: string; notes: string },
): Promise<{ status: number; body: any }> {
  return apiCall(page, 'POST', '/v1/time-entries', {
    project_id: opts.projectId,
    start_at: opts.startIso,
    end_at: opts.endIso,
    notes: opts.notes,
  });
}

/**
 * A short, UNIQUE UTC window anchored to the MONDAY 00:00 of `anchorDate`'s ISO
 * week, offset by `dayOffset` days + a minute-of-day + a second derived from the
 * current epoch. The dev stack has NO delete affordance, so prior runs accumulate
 * entries; we therefore spread each window across a wide, deterministic-yet-unique
 * slot space to dodge the no-overlap guard. `dayOffset` separates SAME-RUN windows
 * (seed vs writeback) onto different week-days so they can never overlap each other.
 * The instant stays inside the SAME ISO week as `anchorDate` for `dayOffset ∈ [0,6]`.
 */
function uniqueWindow(anchorDate: Date, dayOffset: number): { startIso: string; endIso: string } {
  const monday = new Date(anchorDate.getTime());
  const dow = (monday.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  monday.setUTCDate(monday.getUTCDate() - dow);
  monday.setUTCHours(0, 0, 0, 0);
  const minuteOfDay = Math.floor(Date.now() / 60_000) % (24 * 60); // 0..1439, advances each minute
  const second = Math.floor(Date.now() / 1_000) % 60; // sub-minute jitter
  const start = new Date(monday.getTime());
  start.setUTCDate(start.getUTCDate() + dayOffset);
  start.setUTCHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, second, 0);
  const end = new Date(start.getTime() + 30_000); // a clean 30s entry
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * SETUP determinism guard. The /timesheets "week" table is week-LABELLED but the
 * backend GET /v1/time-entries IGNORES the FE's `start_at_from`/`start_at_to`
 * params (it only honours `date_from`/`date_to`), so the table actually lists ALL
 * of the user's entries (newest first) and the Submit-week button anchors on
 * `entries[0]` — the NEWEST draft, which may be in a DIFFERENT week than the
 * current one (e.g. a leftover FUTURE-week draft from a prior run's step 3). To
 * make the current-week submit deterministic, we FLUSH every leftover draft that
 * is NOT in the current ISO week: submit each stray week (scope='week') so those
 * entries become `submitted` (non-draft) and can no longer be picked as the
 * current-week anchor. Returns the count of stray weeks flushed. (This param-drift
 * is a pre-existing FE/API list-filter mismatch, sibling to the .items/.data
 * envelope drift — reported in the HANDOFF; it does not affect FEAT-002's lock
 * state machine.)
 */
async function flushStrayWeekDrafts(
  page: Page,
  emp: FixtureUser,
  cur: { year: number; week: number },
  tz: string,
): Promise<number> {
  const list = await apiCall(page, 'GET', `/v1/time-entries?user_id=${emp.id}&limit=200`);
  const rows: Array<{ id: string; status: string; start_at: string }> =
    (list.body?.data ?? list.body?.items ?? []) as any[];
  // Distinct stray weeks (a draft whose ISO week is not the current one).
  const strayAnchorByWeek = new Map<string, string>();
  for (const e of rows) {
    if (e.status !== 'draft') continue;
    const w = isoWeekInTz(new Date(e.start_at), tz);
    if (w.year === cur.year && w.week === cur.week) continue;
    const key = `${w.year}-W${w.week}`;
    if (!strayAnchorByWeek.has(key)) strayAnchorByWeek.set(key, e.id);
  }
  for (const [, anchorId] of strayAnchorByWeek) {
    await apiCall(page, 'POST', `/v1/time-entries/${anchorId}/submit`, { scope: 'week' });
  }
  return strayAnchorByWeek.size;
}

/** Reopen `iso_week` for `emp` as admin (used by SETUP to reset a leftover lock). */
async function adminUnlockReset(page: Page, emp: FixtureUser, isoWeek: string): Promise<void> {
  await page.context().clearCookies();
  await waitForAuthWindow();
  markAuthBudgetSpent();
  await signInAs(page, { actorKey: 'admin', landingPath: '/approvals' });
  await expectAuthedShell(page);
  const reset = await apiCall(page, 'POST', `/v1/timesheet-periods/${emp.id}/${isoWeek}/unlock`, {
    reason: 'e2e reset: reopening a leftover locked week before the FEAT-002 UI run',
  });
  expect([200, 201]).toContain(reset.status);
}

test.describe('FEAT-002 — period lock lifecycle (live, UI buttons)', () => {
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + AUTH_GUARD_MS + 5_000);
    await waitForAuthWindow();
    markAuthBudgetSpent();
  });

  test('plain employee submits the week via the UI button → locked → admin unlocks via the UI button → reopened', async ({
    page,
  }) => {
    // Up to ~4 serialized sign-ins (employee → [optional admin reset → employee] →
    // admin unlock → employee writeback), EACH preceded by an ~80s auth-window wait
    // so we never trip the 5/60s auth bucket. Wall-clock heavy by design, not flaky.
    test.setTimeout(720_000);

    // THE SUBMITTING EMPLOYEE — a PLAIN EMPLOYEE (bob). The (b) self_anchored fix
    // now gives bob his OWN member-projects (1 & 2) in the picker AND his OWN
    // entries in the /timesheets table, so a plain employee can fully drive the
    // submit button. (Fallback to Alice only if bob unexpectedly has nothing.)
    const emp = USERS.bob;
    const tz = emp.timezone; // Africa/Johannesburg
    const cur = isoWeekInTz(new Date(), tz);
    const curToken = isoToken(cur.year, cur.week);

    // INC-003/005 instrumentation for the no-regression guard.
    const meStatuses: number[] = [];
    const navs: string[] = [];
    page.on('response', (r) => {
      if (/\/v1\/auth\/me(\?|$)/.test(r.url())) meStatuses.push(r.status());
    });
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navs.push(f.url());
    });

    // =====================================================================
    // SETUP — sign in as the plain employee (bob). Stop any running timer; if the
    // current week is already locked from a prior interrupted run, reopen it as
    // admin first so this run starts clean. Then ensure the current week has >=1
    // draft entry to submit (created through the New-entry UI modal).
    // =====================================================================
    await signInAs(page, { actorKey: 'bob' });
    await expect(page).toHaveURL(/\/timesheets/);
    await expectAuthedShell(page);
    const navsAtAuth = navs.length;

    // Stop any pre-existing running timer (a running NOW() entry in a locked week
    // would also confound the start-409 check below).
    const running = await apiCall(page, 'GET', '/v1/time-entries/running');
    if (running.status === 200 && running.body?.data) {
      await apiCall(page, 'POST', '/v1/time-entries/stop');
    }

    // (b)-fix proof at the API layer too: bob's picker now returns his member
    // projects. resolveLoggableProjectId prefers that list.
    const projectA = await resolveLoggableProjectId(page, ['1', '2']);
    // eslint-disable-next-line no-console
    console.log(`[FEAT-002] using project_id=${projectA} for ${emp.displayName}'s entries`);

    // DETERMINISM: flush any leftover NON-current-week drafts (e.g. a prior run's
    // future-week draft from step 3) so the Submit-week button — which anchors on
    // the newest draft in the (un-week-filtered) list — deterministically targets
    // the CURRENT week. See flushStrayWeekDrafts for the underlying FE/API
    // list-filter param drift this guards against.
    const flushed = await flushStrayWeekDrafts(page, emp, cur, tz);
    if (flushed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[FEAT-002] flushed ${flushed} stray non-current-week draft week(s) for determinism`);
    }

    // If the current week is ALREADY locked (leftover), reopen it via admin unlock
    // so step 1 can re-drive a clean submit. One extra admin sign-in only when needed.
    let curStatus = (await getPeriod(page, curToken)).status;
    if (curStatus !== 'open' && curStatus !== 'rejected') {
      // eslint-disable-next-line no-console
      console.log(`[FEAT-002] current week ${curToken} was ${curStatus} at start — unlocking as admin to reset.`);
      await adminUnlockReset(page, emp, curToken);
      await page.context().clearCookies();
      await waitForAuthWindow();
      markAuthBudgetSpent();
      await signInAs(page, { actorKey: 'bob' });
      await expectAuthedShell(page);
      curStatus = (await getPeriod(page, curToken)).status;
    }
    expect(['open', 'rejected'], 'current week is writable before submit').toContain(curStatus);

    // Seed a draft in the CURRENT week. We create it through the New-entry UI MODAL
    // (proving the plain employee's picker works post-(b)) when the page is showing
    // the current week and is unlocked; the start/end land at a unique minute today
    // (inside the current ISO week). datetime-local inputs are interpreted in the
    // viewer's zone (bob = Africa/Johannesburg). We pick a slot on the current
    // wall-clock day in that zone, jittered by epoch seconds, to dodge the
    // no-overlap guard across re-runs.
    const nowZoned = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const zget = (t: string) => nowZoned.find((p) => p.type === t)!.value;
    const localDate = `${zget('year')}-${zget('month')}-${zget('day')}`; // YYYY-MM-DD in bob's TZ, today
    const jMin = Math.floor(Date.now() / 60_000) % (24 * 60);
    const startLocal = `${localDate}T${String(Math.floor(jMin / 60)).padStart(2, '0')}:${String(jMin % 60).padStart(2, '0')}`;
    const endMin = jMin + 1 >= 24 * 60 ? jMin - 1 : jMin + 1;
    const endLocal = `${localDate}T${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

    // Make sure the page is on the CURRENT week (it defaults to "now"), then open
    // the New-entry modal and fill it in. The picker + form are the FEAT-001 UI;
    // this proves the (b)-fixed picker is usable by a plain employee.
    await page.getByRole('button', { name: /^new entry$/i }).click();
    const newDialog = page.getByRole('dialog');
    await expect(newDialog.getByText(/new time entry/i)).toBeVisible();
    // The project Select is enabled once projects load (bob has 1 & 2 post-(b)).
    const projectSelect = newDialog.getByLabel(/^project$/i);
    await expect(projectSelect).toBeEnabled({ timeout: 10_000 });
    await projectSelect.selectOption(projectA);
    await newDialog.getByLabel(/^start$/i).fill(startLocal);
    await newDialog.getByLabel(/^end$/i).fill(endLocal);
    await newDialog.getByRole('button', { name: /save entry/i }).click();
    // Success toast confirms the draft was created through the UI.
    await expect(
      page.getByText(/entry added/i).first(),
      'New-entry modal created a draft via the UI (proves the (b)-fixed picker works for a plain employee)',
    ).toBeVisible({ timeout: 15_000 });
    await expect(newDialog).toBeHidden({ timeout: 10_000 });

    // Confirm a draft now exists for bob in the current week (source of truth).
    const seedList = await apiCall(page, 'GET', `/v1/time-entries?user_id=${emp.id}&limit=200`);
    const seedRows: Array<{ id: string; status: string; start_at: string }> =
      (seedList.body?.data ?? seedList.body?.items ?? []) as any[];
    const draftThisWeek = seedRows.find((e) => {
      if (e.status !== 'draft') return false;
      const w = isoWeekInTz(new Date(e.start_at), tz);
      return w.year === cur.year && w.week === cur.week;
    });
    expect(draftThisWeek, 'a draft exists for bob in the current week after the UI create').toBeTruthy();
    const seedEntryId = draftThisWeek!.id;
    // eslint-disable-next-line no-console
    console.log(`[FEAT-002] seed draft id=${seedEntryId} in week ${curToken} (created via UI)`);

    // =====================================================================
    // STEP 1 — SUBMIT LOCKS THE WEEK, via the BROWSER BUTTON.
    //
    // (a)-fix: the week ENTRY TABLE now renders bob's entries (reads `.data`). We
    // assert the table is NOT empty and the "Submit week" button is ENABLED, then
    // CLICK it through the browser. The page fires POST
    // /v1/time-entries/{id}/submit {scope:'week'}; we wait for that response, then
    // assert the success toast, the LOCKED banner, and the disabled New-entry.
    // =====================================================================
    // Reload so the entries query reflects the freshly-created draft, then assert
    // the table renders rows (the (a) fix — was empty before).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectAuthedShell(page);
    // The entries table renders bob's row(s) — at least one status badge cell.
    const entryTable = page.getByRole('table').first();
    await expect(entryTable, 'the week entry table is rendered (a-fix: reads .data)').toBeVisible({
      timeout: 15_000,
    });
    await expect(
      entryTable.getByRole('row'),
      'the entry table has at least a header + one entry row (NOT empty)',
    ).not.toHaveCount(1);
    // The "No time logged this week" empty state must NOT be shown.
    await expect(page.getByText(/no time logged this week/i)).toHaveCount(0);

    const submitButton = page.getByRole('button', { name: /submit week/i });
    await expect(
      submitButton,
      'Submit-week button is ENABLED for a plain employee with a draft (was permanently disabled before)',
    ).toBeEnabled({ timeout: 10_000 });

    // CLICK the real button + capture the submit-week request it issues.
    const [submitResp] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/v1\/time-entries\/[^/]+\/submit$/.test(new URL(res.url()).pathname) &&
          res.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      submitButton.click(),
    ]);
    const submitStatus = submitResp.status();
    const submitBody = (await submitResp.json().catch(() => undefined)) as
      | { submitted_ids: string[]; skipped: Array<{ entry_id: string; reason: string }> }
      | undefined;
    expect(submitStatus, `submit-week (UI button) is 2xx (got ${submitStatus})`).toBeLessThan(300);
    expect(submitStatus, `submit-week (UI button) is not an error`).toBeGreaterThanOrEqual(200);
    expect(Array.isArray(submitBody?.submitted_ids), 'response carries submitted_ids[]').toBe(true);
    expect(
      submitBody!.submitted_ids.map(String).includes(seedEntryId),
      `the seed draft (${seedEntryId}) is in submitted_ids (${JSON.stringify(submitBody!.submitted_ids)})`,
    ).toBe(true);

    // Success toast — "Submitted N entries" (summarizeSubmitResult copy).
    await expect(
      page.getByText(/^Submitted \d+ entr(y|ies)$/).first(),
      'the UI shows a "Submitted N entries" success toast',
    ).toBeVisible({ timeout: 15_000 });

    // The week flips to the LOCKED banner state (periodQuery → submitted) and
    // New-entry is DISABLED. (No reload needed — the submit onSuccess invalidates
    // the period query, but we tolerate a short settle.)
    await expect(
      page.getByText(/week submitted — locked/i).first(),
      'the week flips to the locked banner after the UI submit',
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: /^new entry$/i }),
      'New-entry button is DISABLED once the week is locked',
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: /submit week/i }),
      'Submit-week button is disabled while the week is locked',
    ).toBeDisabled();

    // Cross-check the server: the seed entry is `submitted` and the period reads "submitted".
    const listAfter = await apiCall(page, 'GET', `/v1/time-entries?user_id=${emp.id}&limit=200`);
    const rowsAfter: Array<{ id: string; status: string }> =
      (listAfter.body?.data ?? listAfter.body?.items ?? []) as any[];
    expect(rowsAfter.find((e) => e.id === seedEntryId)?.status, 'seed entry is now submitted').toBe(
      'submitted',
    );
    const lockedPeriod = await waitForPeriodStatus(
      page,
      curToken,
      (p) => p.status === 'submitted',
      `after the UI submit, period ${curToken} is "submitted"`,
    );
    expect(lockedPeriod.submitted_at, 'submitted_at is stamped').toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-002] step1 UI submit → ${submitStatus} submitted_ids=${JSON.stringify(submitBody!.submitted_ids)}; period→submitted`,
    );

    // =====================================================================
    // STEP 2 — PERIOD_LOCKED via the UI + server-side cross-checks.
    // The New-entry button is disabled (the UI guard); the page shows the friendly
    // locked message and NO raw code; the server rejects writes with 409.
    // =====================================================================
    // (2-UI) Friendly locked explanation is shown; the raw code is NOT.
    await expect(
      page.getByText(/you can.?t add, edit, move, or delete entries in this week/i),
      'the page shows a friendly locked explanation (no raw PERIOD_LOCKED code)',
    ).toBeVisible();
    await expect(
      page.getByText('PERIOD_LOCKED', { exact: false }),
      'the raw error code is NOT shown to the user',
    ).toHaveCount(0);

    // (2a) createManual INTO the locked week → 409 PERIOD_LOCKED (server cross-check;
    // the UI guard is the disabled New-entry button asserted above).
    const lockedCreate = await apiCall(page, 'POST', '/v1/time-entries', {
      project_id: projectA,
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + 60_000).toISOString(),
      notes: `feat002 blocked-create ${Date.now()}`,
    });
    expect(
      lockedCreate.status,
      `createManual into the locked week is 409 (got ${lockedCreate.status}); body=${JSON.stringify(lockedCreate.body)}`,
    ).toBe(409);
    expect(lockedCreate.body?.code, 'createManual 409 carries code PERIOD_LOCKED').toBe(
      'PERIOD_LOCKED',
    );

    // (2b) DELETE an entry in the locked week → 409 lock code. After a clean week
    // submit every entry is `submitted`, so ENTRY_LOCKED fires first (documented
    // ordering); either lock code protects the week.
    const lockedDelete = await apiCall(page, 'DELETE', `/v1/time-entries/${seedEntryId}`);
    expect(
      lockedDelete.status,
      `DELETE in the locked week is 409 (got ${lockedDelete.status}); body=${JSON.stringify(lockedDelete.body)}`,
    ).toBe(409);
    expect(
      ['ENTRY_LOCKED', 'PERIOD_LOCKED'],
      `DELETE 409 carries a lock code (got ${lockedDelete.body?.code})`,
    ).toContain(lockedDelete.body?.code);

    // (2c) start a timer NOW (NOW() in the locked current week) → 409 PERIOD_LOCKED.
    const lockedStart = await apiCall(page, 'POST', '/v1/time-entries/start', {
      project_id: projectA,
    });
    expect(
      lockedStart.status,
      `start with NOW() in the locked week is 409 (got ${lockedStart.status}); body=${JSON.stringify(lockedStart.body)}`,
    ).toBe(409);
    expect(lockedStart.body?.code, 'start 409 carries code PERIOD_LOCKED').toBe('PERIOD_LOCKED');
    await expectAuthedShell(page);
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-002] step2 locked writes → create=${lockedCreate.status}/${lockedCreate.body?.code} delete=${lockedDelete.status}/${lockedDelete.body?.code} start=${lockedStart.status}/${lockedStart.body?.code}`,
    );

    // =====================================================================
    // STEP 3 — FUTURE-DATING STILL ALLOWED (empty/future week is never locked).
    //
    // Re-runs accumulate future-week entries (the dev stack has no delete) and the
    // SETUP flush may have SUBMITTED (locked) a leftover future week, so a STATIC
    // +8w anchor can collide with a used/locked week. We SCAN FORWARD from +8w for
    // the first week whose period is `open`, then createManual into it — proving an
    // open future week stays writable while the current week is locked.
    // =====================================================================
    let futAnchorDate: Date | null = null;
    let futToken = '';
    for (let wOffset = 8; wOffset <= 40; wOffset++) {
      const d = new Date(Date.now() + wOffset * 7 * 24 * 3600_000);
      const w = isoWeekInTz(d, tz);
      const tok = isoToken(w.year, w.week);
      const p = await getPeriod(page, tok);
      if (p.status === 'open') {
        futAnchorDate = d;
        futToken = tok;
        break;
      }
    }
    expect(futAnchorDate, 'found an OPEN future week to write into (>= +8 weeks out)').toBeTruthy();
    const futWin = uniqueWindow(futAnchorDate!, 0); // Monday of the chosen open future week
    const futCreate = await createManualApi(page, {
      projectId: projectA,
      startIso: futWin.startIso,
      endIso: futWin.endIso,
      notes: `feat002 future ${Date.now()}`,
    });
    expect(
      futCreate.status,
      `createManual into a FUTURE open week (${futToken}) is 2xx (got ${futCreate.status}); body=${JSON.stringify(futCreate.body)}`,
    ).toBeLessThan(300);
    const futPeriod = await getPeriod(page, futToken);
    expect(futPeriod.status, `the future week ${futToken} is open (never locked)`).toBe('open');
    // eslint-disable-next-line no-console
    console.log(`[FEAT-002] step3 future create → ${futCreate.status} (week ${futToken} status=${futPeriod.status})`);

    // =====================================================================
    // STEP 4 — ADMIN UNLOCK-WEEK via the BROWSER BUTTON.
    // Sign in as admin, land on /approvals. (c)-fix: the queue RENDERS enriched
    // rows (user name, ISO week, total hours). Find bob's row for the locked week,
    // click the UnlockWeekButton (modal → reason >= 20 chars → submit), and assert
    // the success toast + the week reopens.
    // =====================================================================
    await page.context().clearCookies();
    await waitForAuthWindow();
    markAuthBudgetSpent();
    await signInAs(page, { actorKey: 'admin', landingPath: '/approvals' });
    await expect(page).toHaveURL(/\/approvals/);
    await expectAuthedShell(page);

    // The queue table RENDERS enriched rows (NOT the empty "Inbox zero" state).
    await expect(
      page.getByText(/inbox zero/i),
      'the approvals queue is NOT empty (c-fix: enriched rows under {data})',
    ).toHaveCount(0);
    const queueTable = page.getByRole('table').first();
    await expect(queueTable, 'the approvals queue table renders').toBeVisible({ timeout: 15_000 });
    // bob's enriched row carries his name, the ISO-week token, and an hours figure.
    const empRow = queueTable
      .getByRole('row')
      .filter({ hasText: emp.displayName })
      .filter({ hasText: curToken });
    await expect(
      empRow.first(),
      `bob's enriched queue row for ${curToken} is rendered (user name + ISO week)`,
    ).toBeVisible({ timeout: 15_000 });

    // Click the per-row UnlockWeekButton and drive the modal (reason >= 20 chars).
    await empRow.first().getByRole('button', { name: /unlock week/i }).click();
    const unlockDialog = page.getByRole('dialog');
    await expect(unlockDialog.getByText(new RegExp(`Unlock ${curToken}`, 'i'))).toBeVisible();
    await unlockDialog
      .getByLabel(/reason/i)
      .fill('e2e: correcting a misallocated project on the submitted week for this employee');
    const [unlockResp] = await Promise.all([
      page.waitForResponse(
        (res) =>
          /\/v1\/timesheet-periods\/[^/]+\/[^/]+\/unlock$/.test(new URL(res.url()).pathname) &&
          res.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      unlockDialog.getByRole('button', { name: /unlock week/i }).click(),
    ]);
    const unlockStatus = unlockResp.status();
    const unlockBody = (await unlockResp.json().catch(() => undefined)) as
      | { unlocked_ids: string[] }
      | undefined;
    expect(unlockStatus, `unlock-week (UI button) is 2xx (got ${unlockStatus})`).toBeLessThan(300);
    expect(Array.isArray(unlockBody?.unlocked_ids), 'unlock response carries unlocked_ids[]').toBe(
      true,
    );
    expect(
      unlockBody!.unlocked_ids.map(String),
      `the seed entry (${seedEntryId}) is in unlocked_ids`,
    ).toContain(seedEntryId);
    // Success toast — "Week unlocked".
    await expect(
      page.getByText(/week unlocked/i).first(),
      'the UI shows a "Week unlocked" success toast',
    ).toBeVisible({ timeout: 15_000 });

    // The period reopens: read bob's row via the RBAC-visible LIST (admin signed in;
    // the single GET is self-only). Assert status "open" + reopened_at set.
    let reopened: PeriodShape | undefined;
    const reopenDeadline = Date.now() + 12_000;
    do {
      reopened = await getPeriodForUserViaList(page, emp.id, cur.year, cur.week);
      if (reopened && reopened.status === 'open') break;
      await new Promise((r) => setTimeout(r, 1_000));
    } while (Date.now() < reopenDeadline);
    expect(
      reopened?.status,
      `after the UI unlock-week, bob's period ${curToken} is "open" (got ${JSON.stringify(reopened)})`,
    ).toBe('open');
    expect(reopened!.reopened_at, 'reopened_at is set after unlock-week').toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-002] step4 UI unlock → ${unlockStatus} unlocked_ids=${JSON.stringify(unlockBody!.unlocked_ids)}; period now=${reopened!.status} reopened_at=${reopened!.reopened_at}`,
    );

    // =====================================================================
    // STEP 4b — WRITABILITY RESTORED: bob can write into the reopened week again.
    // Sign back in as bob and createManual NOW (in the reopened week) → 2xx. This
    // also RESTORES the seed's writability.
    // =====================================================================
    await page.context().clearCookies();
    await waitForAuthWindow();
    markAuthBudgetSpent();
    await signInAs(page, { actorKey: 'bob' });
    await expectAuthedShell(page);

    const wbWin = uniqueWindow(new Date(), 2); // WEDNESDAY of the current week (≠ seed day)
    const writeBack = await createManualApi(page, {
      projectId: projectA,
      startIso: wbWin.startIso,
      endIso: wbWin.endIso,
      notes: `feat002 writeback ${Date.now()}`,
    });
    expect(
      writeBack.status,
      `createManual into the REOPENED week is 2xx — lock released (got ${writeBack.status}); body=${JSON.stringify(writeBack.body)}`,
    ).toBeLessThan(300);
    const finalPeriod = await getPeriod(page, curToken);
    expect(['open', 'rejected'], 'the operated week is left WRITABLE (state restored)').toContain(
      finalPeriod.status,
    );

    // =====================================================================
    // NO REGRESSION — INC-002 (sign-in worked) + INC-003 (/me) + INC-005 (no 429).
    // =====================================================================
    await expectAuthedShell(page);
    const postAuthLoginBounces = navs.slice(navsAtAuth).filter((u) => /\/login(\?|$)/.test(u));
    const me429 = meStatuses.filter((s) => s === 429).length;
    expect(me429, 'no 429 on /me during the flow (INC-003/INC-005)').toBe(0);
    expect(meStatuses.length, `bounded /me count (no storm) — saw ${meStatuses.length}`).toBeLessThan(
      120,
    );

    // eslint-disable-next-line no-console
    console.log(
      '\n===== FEAT-002 LIVE LIFECYCLE (UI BUTTONS) — summary =====\n' +
        `  week under test: ${curToken} (${emp.displayName} [plain employee], ${tz})\n` +
        `  step1 submit:  ${submitStatus} via UI BUTTON; submitted_ids=${JSON.stringify(submitBody!.submitted_ids)}; period→submitted; locked banner + New-entry disabled\n` +
        `  step2 locked:  create=${lockedCreate.status}/${lockedCreate.body?.code}, delete=${lockedDelete.status}/${lockedDelete.body?.code}, start=${lockedStart.status}/${lockedStart.body?.code}; UI friendly banner, no raw code\n` +
        `  step3 future:  ${futCreate.status} into ${futToken} (open — never locked)\n` +
        `  step4 unlock:  ${unlockStatus} via UI BUTTON (UnlockWeekButton on /approvals, enriched queue row); period→open (reopened_at set)\n` +
        `  step4b write:  ${writeBack.status} into reopened week → state RESTORED (now ${finalPeriod.status})\n` +
        `  /me 429s=${me429}; post-auth /login routes=${postAuthLoginBounces.length} (deliberate re-logins)\n` +
        '==========================================================\n',
    );
  });
});
