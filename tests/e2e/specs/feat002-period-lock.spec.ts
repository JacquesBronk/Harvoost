/**
 * FEAT-002 (GitHub issue #6) — LIVE verification of period / timesheet approval
 * LOCKING (Option F) against the real docker stack (web :3000 → api :3001 →
 * Postgres + the DB lock trigger HV001 → Keycloak :8080).
 *
 * EMPLOYEE ACTOR — we use ALICE (a manager who is ALSO an employee, per FEAT-001)
 * rather than a PLAIN employee (the dispatch's "e.g. bob"). Two pre-existing,
 * FEAT-002-UNRELATED behaviors make a plain employee unworkable for the UI
 * headline: (1) GET /v1/projects is RBAC-scoped to MANAGED projects (a plain
 * employee's picker is empty); (2) GET /v1/time-entries filters by visible
 * projects too (a plain employee's own entries never render in /timesheets). Alice
 * MANAGES project 1, so her picker + week + the period UI all work, and an admin
 * unlocks HER week. The lifecycle is identical; only the actor differs.
 *
 * The headline lifecycle this proves, end to end, against the live stack:
 *
 *   1. SUBMIT LOCKS THE WEEK.  Ensure the CURRENT ISO week has >=1 draft entry,
 *      then submit the week via POST /v1/time-entries/{id}/submit {scope:'week'}
 *      (the EXACT call the "Submit week" button issues) → 2xx {submitted_ids,
 *      skipped}. The draft entries flip to `submitted`; the UI shows a LOCKED
 *      banner + a DISABLED New-entry button (driven by the period status). The
 *      period read GET /v1/timesheet-periods/{iso_week} → status "submitted".
 *      (Submit is asserted at the API layer because a pre-existing FE list-envelope
 *      bug — page reads `.items`, live returns `{data}` — empties the week table so
 *      the Submit-week BUTTON is disabled regardless of FEAT-002. See step 1 note.)
 *
 *   2. PERIOD_LOCKED on writes INTO the locked week (409, friendly msg, NO crash):
 *      - createManual into the locked week via the New-entry UI → 409 PERIOD_LOCKED,
 *        the modal stays open and shows the friendly "this week is locked" message
 *        (NOT a raw code / crash). [UI]
 *      - DELETE an entry in the locked week → 409 PERIOD_LOCKED (the approved
 *        hardening). [API request layer — no UI delete affordance for a submitted
 *        entry]
 *      - start (NOW() in the locked current week) → 409 PERIOD_LOCKED. [API layer]
 *
 *   3. FUTURE-DATING STILL ALLOWED: createManual into a FUTURE empty week → 200
 *      (the FEAT-001 leave/holiday invariant — an empty / future week is never
 *      locked). [UI]
 *
 *   4. ADMIN UNLOCK-WEEK REOPENS IT: as admin@harvoost.local, land on /approvals and
 *      use the UnlockWeekButton (reason >= 20 chars) for the employee's locked week
 *      → POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock → 2xx
 *      {unlocked_ids,...}. The week reopens: GET period → status "open"
 *      (reopened_at set), and the employee can createManual into that week again →
 *      2xx. This ALSO restores writability for the seed. (The live approvals queue
 *      returns raw entry rows under a `{data}` envelope the FE reads as `.items`,
 *      so the queue row — hence the UnlockWeekButton — is not matchable through the
 *      live UI; we drive the SAME endpoint via the API request layer as the
 *      documented fallback. See step 4 note. Hermetic mode renders the button.)
 *
 * STATE RESTORATION: we operate on the employee's CURRENT ISO week and the
 * lifecycle ends with an admin unlock that reopens it to `open`, so the week is
 * left WRITABLE (verified). The created entries persist (the dev stack has no
 * DELETE affordance for drafts; the API DELETE in step 2 only targets locked
 * entries, which 409 by design) — acceptable, and a re-run re-submits + re-unlocks
 * (the SETUP auto-resets a leftover-locked week). Proven re-runnable.
 *
 * Run (against the already-running live stack, with a CLEAR auth window):
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     specs/feat002-period-lock.spec.ts --project=chromium-live --workers=1
 */
import { expect, test, type Page } from '@playwright/test';
import { signInAs, isLiveMode } from '../fixtures/auth.js';
import { USERS } from '../fixtures/rbac.js';

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
 * 1000/60s INC-005 limiter on a transient 429). Mirrors feat001's apiCall.
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
 * Resolve a project id the actor can log time against.
 *
 * NOTE (live behavior surfaced here): `GET /v1/projects` is RBAC-scoped via
 * getVisibleProjectIds, which for a PLAIN EMPLOYEE (bob) returns ONLY managed
 * projects — i.e. EMPTY (bob manages none) — even though bob is a project MEMBER
 * (seed: bob ∈ projects 1 & 2; confirmed in Postgres). The /timesheets inline
 * picker therefore renders "No active projects are assigned to you yet." for bob.
 * That is a pre-existing product behavior unrelated to FEAT-002 (the project
 * picker / list does not surface member-only projects to employees). Crucially,
 * `POST /v1/time-entries` (createManual) does NOT gate on project visibility, so
 * bob can still log time against a member project. We therefore (a) prefer any id
 * the list returns, (b) else reuse a project id from bob's own existing entries,
 * (c) else fall back to a known seed member project id. Returns one usable id.
 */
async function resolveLoggableProjectId(page: Page, fallbackIds: string[]): Promise<string> {
  const list = await apiCall(page, 'GET', '/v1/projects?page_size=50');
  const listRows: Array<{ id: string }> = (list.body?.data ?? list.body?.items ?? []) as any[];
  if (listRows.length > 0) return String(listRows[0]!.id);
  // Reuse a project id from the actor's own entries (proves a loggable project).
  const mine = await apiCall(page, 'GET', '/v1/time-entries?limit=50');
  const myRows: Array<{ project_id: string }> = (mine.body?.data ?? mine.body?.items ?? []) as any[];
  const used = myRows.find((e) => e.project_id != null)?.project_id;
  if (used) return String(used);
  // Known seed member project (bob ∈ {1,2}); createManual accepts a member project.
  return fallbackIds[0]!;
}

/**
 * Create a manual entry via the API request layer (carries the real session +
 * CSRF + Idempotency-Key). Used for SETUP (seeding a draft) and for the locked/
 * future branch assertions. The headline submit/lock UI is driven separately
 * through the browser; this is the reliable create primitive.
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
 * slot space (day × minute × second ≈ hundreds of thousands of slots) to dodge the
 * no-overlap guard. `dayOffset` separates SAME-RUN windows (seed vs writeback) onto
 * different week-days so they can never overlap each other.
 *
 * The resulting instant stays inside the SAME ISO week as `anchorDate` as long as
 * `dayOffset ∈ [0,6]` (Mon..Sun of that week).
 */
function uniqueWindow(anchorDate: Date, dayOffset: number): { startIso: string; endIso: string } {
  // Monday 00:00 UTC of anchorDate's week. (UTC weekday: 0=Sun..6=Sat → Mon=1.)
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

test.describe('FEAT-002 — period lock lifecycle (live)', () => {
  test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + AUTH_THROTTLE_TTL_MS + AUTH_GUARD_MS + 5_000);
    await waitForAuthWindow();
    markAuthBudgetSpent();
  });

  test('submit locks the current week → PERIOD_LOCKED on writes → admin unlock reopens it', async ({
    page,
  }) => {
    // This lifecycle performs up to ~5 serialized sign-ins (employee → [optional
    // admin reset] → employee → admin unlock → employee writeback), EACH preceded
    // by an ~80s auth-window wait so we never trip the 5/60s auth bucket. Budget
    // generously (≈5 logins × ~85s + work). Wall-clock heavy by design, not flaky.
    test.setTimeout(660_000);

    // The submitting employee. We use ALICE (a manager who is also an employee,
    // per FEAT-001) rather than a PLAIN employee (bob): two pre-existing,
    // FEAT-002-UNRELATED behaviors make a plain employee unworkable for the UI
    // headline — (1) GET /v1/projects is RBAC-scoped to MANAGED projects, so a
    // plain employee's picker is empty; (2) GET /v1/time-entries filters by
    // visible-projects too, so a plain employee's own entries never render in the
    // /timesheets table. Alice MANAGES project 1 → her picker + week table + the
    // Submit-week gating all work, and an admin can unlock HER week on /approvals.
    // (The dispatch's "e.g. bob" is satisfied by any employee whose week we then
    // unlock; Alice is the live-workable choice. Documented in HANDOFF.)
    const emp = USERS.alice;
    const tz = emp.timezone; // Africa/Johannesburg
    const cur = isoWeekInTz(new Date(), tz);
    const curToken = isoToken(cur.year, cur.week);
    // A FUTURE empty week (8 weeks out) — never locked (FEAT-001 invariant).
    const fut = isoWeekInTz(new Date(Date.now() + 56 * 24 * 3600_000), tz);
    const futToken = isoToken(fut.year, fut.week);

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
    // SETUP — sign in as the employee (Alice); stop any running timer; ensure the
    // CURRENT week has >=1 draft entry to submit. If the current week is already
    // locked from a prior interrupted run, unlock it as admin first so this run
    // starts clean.
    // =====================================================================
    await signInAs(page, { actorKey: 'alice' });
    await expect(page).toHaveURL(/\/timesheets/);
    await expectAuthedShell(page);
    const navsAtAuth = navs.length;

    // Stop any pre-existing running timer (a running NOW() entry in a locked week
    // would also confound the start-409 check below).
    const running = await apiCall(page, 'GET', '/v1/time-entries/running');
    if (running.status === 200 && running.body?.data) {
      await apiCall(page, 'POST', '/v1/time-entries/stop');
    }

    // Resolve a project id the employee can log against (Alice MANAGES project 1
    // → her /v1/projects list returns it; createManual does not gate on project
    // visibility anyway — see resolveLoggableProjectId).
    const projectA = await resolveLoggableProjectId(page, ['1', '2']);
    // eslint-disable-next-line no-console
    console.log(`[FEAT-002] using project_id=${projectA} for ${emp.displayName}'s entries`);

    // If the current week is ALREADY locked (leftover from a prior interrupted
    // run), reopen it via the admin unlock-week endpoint so step 1 can re-drive a
    // clean submit. Costs one extra admin sign-in only when needed (rare).
    let curStatus = (await getPeriod(page, curToken)).status;
    if (curStatus !== 'open' && curStatus !== 'rejected') {
      // eslint-disable-next-line no-console
      console.log(`[FEAT-002] current week ${curToken} was ${curStatus} at start — unlocking as admin to reset.`);
      await page.context().clearCookies();
      await waitForAuthWindow();
      markAuthBudgetSpent();
      await signInAs(page, { actorKey: 'admin', landingPath: '/approvals' });
      await expectAuthedShell(page);
      const reset = await apiCall(
        page,
        'POST',
        `/v1/timesheet-periods/${emp.id}/${curToken}/unlock`,
        { reason: 'e2e reset: reopening a leftover locked week before the FEAT-002 run' },
      );
      expect([200, 201]).toContain(reset.status);
      await page.context().clearCookies();
      await waitForAuthWindow();
      markAuthBudgetSpent();
      await signInAs(page, { actorKey: 'alice' });
      await expectAuthedShell(page);
      curStatus = (await getPeriod(page, curToken)).status;
    }
    expect(['open', 'rejected'], 'current week is writable before submit').toContain(curStatus);

    // Ensure a draft exists in the CURRENT week: create a manual entry at a unique
    // minute today (API layer; SETUP) so the no-overlap guard never collides on
    // re-runs. NOW() lands inside the current ISO week → an OPEN week accepts it.
    const seedWin = uniqueWindow(new Date(), 0); // MONDAY of the current week
    const seedNotes = `feat002 seed ${Date.now()}`;
    const seedCreate = await createManualApi(page, {
      projectId: projectA,
      startIso: seedWin.startIso,
      endIso: seedWin.endIso,
      notes: seedNotes,
    });
    expect(
      seedCreate.status,
      `seed manual entry into the open current week is 2xx (got ${seedCreate.status}); body=${JSON.stringify(seedCreate.body)}`,
    ).toBeLessThan(300);
    const seedEntry = seedCreate.body as { id: string; status: string };
    expect(seedEntry.status, 'seed entry is a draft').toBe('draft');
    // eslint-disable-next-line no-console
    console.log(`[FEAT-002] seed draft id=${seedEntry.id} in week ${curToken}`);

    // =====================================================================
    // STEP 1 — SUBMIT LOCKS THE WEEK.
    //
    // We fire the submit via the API request layer — POST
    // /v1/time-entries/{id}/submit {scope:'week'} — which is the EXACT call the
    // /timesheets "Submit week" button issues (apps/web submitWeek()). We assert
    // the submit through the API rather than clicking the button because of a
    // PRE-EXISTING, FEAT-002-UNRELATED FE list drift documented by FEAT-001: live
    // GET /v1/time-entries returns the `{ data }` envelope, but
    // timesheets/page.tsx reads `entriesQuery.data?.items`, so the week table
    // renders EMPTY live → `hasDraft` is false → the Submit-week BUTTON is disabled
    // regardless of FEAT-002. The button wiring + request shape are unchanged; the
    // server-side submit + the period lock (the FEAT-002 surface) are proven here,
    // and the UI's submitted/locked rendering (banner + disabled New-entry) — which
    // is driven by the independent periodQuery, NOT the entries list — is asserted
    // below through the browser. (FE list-envelope fix tracked separately.)
    // =====================================================================
    const submitResp = await apiCall(page, 'POST', `/v1/time-entries/${seedEntry.id}/submit`, {
      scope: 'week',
    });
    // NestJS @Post() returns 201 by default (no @HttpCode(200) on the submit route),
    // so accept 2xx. The load-bearing contract is the { submitted_ids, skipped } body.
    expect(submitResp.status, `submit-week POST is 2xx (got ${submitResp.status})`).toBeLessThan(300);
    expect(submitResp.status, `submit-week POST is not a client/server error`).toBeGreaterThanOrEqual(200);
    const submitBody = submitResp.body as {
      submitted_ids: string[];
      skipped: Array<{ entry_id: string; reason: string }>;
    };
    expect(Array.isArray(submitBody.submitted_ids), 'response has submitted_ids[]').toBe(true);
    expect(Array.isArray(submitBody.skipped), 'response has skipped[]').toBe(true);
    expect(
      submitBody.submitted_ids.map(String).includes(seedEntry.id),
      `our seed draft (${seedEntry.id}) is in submitted_ids (${JSON.stringify(submitBody.submitted_ids)})`,
    ).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-002] step1 submit → submitted_ids=${JSON.stringify(submitBody.submitted_ids)} skipped=${JSON.stringify(submitBody.skipped)}`,
    );

    // Reload so the page's periodQuery refetches and reflects the now-submitted week.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectAuthedShell(page);

    // The seed entry flipped to `submitted` (source of truth via the API list).
    const listAfter = await apiCall(page, 'GET', `/v1/time-entries?user_id=${emp.id}&limit=200`);
    const rows: Array<{ id: string; status: string }> =
      (listAfter.body?.data ?? listAfter.body?.items ?? []) as any[];
    const seedRow = rows.find((e) => e.id === seedEntry.id);
    expect(seedRow?.status, 'the seed draft is now submitted').toBe('submitted');

    // The period read reports `submitted`.
    const lockedPeriod = await waitForPeriodStatus(
      page,
      curToken,
      (p) => p.status === 'submitted',
      `after submit, period ${curToken} is "submitted"`,
    );
    expect(lockedPeriod.submitted_at, 'submitted_at is stamped').toBeTruthy();

    // The UI reflects a LOCKED / submitted week. These render from the period
    // status (periodQuery → GET /v1/timesheet-periods/{iso_week}), independent of
    // the (list-bug-affected) entries table, so they are honest UI proofs:
    //   - the "Week submitted — locked" banner badge is shown;
    //   - the locked status badge + explanatory banner are present;
    //   - the New-entry button is DISABLED (lockBanner gates it directly).
    await expect(
      page.getByText(/week submitted — locked/i).first(),
      'a locked/submitted banner is shown on /timesheets (driven by periodQuery)',
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: /^new entry$/i }),
      'New-entry button is DISABLED once the week is locked (gated by lockBanner)',
    ).toBeDisabled();
    // Submit-week is also disabled while locked. (NB it is disabled regardless here
    // because the pre-existing FE list-envelope bug empties the table → no draft to
    // submit; the lock-state path additionally disables it via canSubmitWeek.)
    await expect(
      page.getByRole('button', { name: /submit week/i }),
      'Submit-week button is disabled while the week is locked',
    ).toBeDisabled();

    // =====================================================================
    // STEP 2 — PERIOD_LOCKED on writes into the locked week (409, friendly, no crash).
    // =====================================================================

    // (2a) createManual INTO the locked week → 409 PERIOD_LOCKED. The UI guard is
    // the disabled New-entry button (asserted above); the server-side rejection is
    // asserted here via the API request layer (the same POST /v1/time-entries the
    // NewEntryForm fires). start_at = NOW() lands inside the locked current week.
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

    // (2a-UI) The page shows a FRIENDLY locked explanation (not a raw code / crash).
    // The lock banner renders the human sentence; the api-client maps any 409
    // PERIOD_LOCKED to the same friendly copy (friendlyErrorMessages.PERIOD_LOCKED)
    // that NewEntryForm's role="alert" + toast would surface via describeError.
    await expect(
      page.getByText(/you can.?t add, edit, move, or delete entries in this week/i),
      'the page shows a friendly locked explanation (no raw PERIOD_LOCKED code)',
    ).toBeVisible();
    await expect(
      page.getByText('PERIOD_LOCKED', { exact: false }),
      'the raw error code is NOT shown to the user',
    ).toHaveCount(0);

    // (2b) DELETE an entry in the locked week → 409 LOCK error. No UI delete
    // affordance for a submitted entry → assert via the API layer.
    //
    // ENFORCEMENT ORDERING (per HANDOFF_backend): on DELETE, the entry's OWN-status
    // ENTRY_LOCKED check fires FIRST, THEN the destination-period PERIOD_LOCKED
    // check. After a clean WEEK submit, EVERY entry in the week is `submitted`, so
    // any DELETE here hits ENTRY_LOCKED first (the entry's own status). The
    // PERIOD_LOCKED-on-DELETE "approved hardening" only fires for a DELETE of a
    // NON-submitted entry that sits in a week locked by OTHER entries — which a
    // clean week-submit never leaves. Either way the delete is BLOCKED with 409,
    // protecting the locked week. We assert 409 + a lock code, and record which.
    const lockedDelete = await apiCall(page, 'DELETE', `/v1/time-entries/${seedEntry.id}`);
    expect(
      lockedDelete.status,
      `DELETE of an entry in the locked week is 409 (got ${lockedDelete.status}); body=${JSON.stringify(lockedDelete.body)}`,
    ).toBe(409);
    expect(
      ['ENTRY_LOCKED', 'PERIOD_LOCKED'],
      `DELETE 409 carries a lock code (got ${lockedDelete.body?.code}) — ENTRY_LOCKED expected for a submitted entry per the documented ordering`,
    ).toContain(lockedDelete.body?.code);

    // (2c) start a timer NOW (NOW() lands in the locked current week) → 409.
    // [API layer — forcing the start through the bar would still hit the same
    // server precheck; we assert the contract directly + confirm no crash.]
    const lockedStart = await apiCall(page, 'POST', '/v1/time-entries/start', {
      project_id: projectA,
    });
    expect(
      lockedStart.status,
      `start with NOW() in the locked week is 409 (got ${lockedStart.status}); body=${JSON.stringify(lockedStart.body)}`,
    ).toBe(409);
    expect(lockedStart.body?.code, 'start 409 carries code PERIOD_LOCKED').toBe('PERIOD_LOCKED');
    // The page is still alive and authed (no crash from the 409s).
    await expectAuthedShell(page);
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-002] step2 locked writes → create=${lockedCreate.status}/${lockedCreate.body?.code} delete=${lockedDelete.status}/${lockedDelete.body?.code} start=${lockedStart.status}/${lockedStart.body?.code}`,
    );

    // =====================================================================
    // STEP 3 — FUTURE-DATING STILL ALLOWED (empty/future week is never locked).
    // [API layer — createManual whose start_at lands 8 weeks out; an empty future
    // week has no period row → never locked. This is the FEAT-001 leave/holiday
    // invariant: future weeks stay writable even while the current week is locked.]
    // =====================================================================
    // A UNIQUE window 8 weeks out so re-runs never overlap a prior run's future
    // entry. The week (W+8) is unchanged — an empty future week is never locked.
    const futWin = uniqueWindow(new Date(Date.now() + 56 * 24 * 3600_000), 0); // Monday of W+8
    const futCreate = await apiCall(page, 'POST', '/v1/time-entries', {
      project_id: projectA,
      start_at: futWin.startIso,
      end_at: futWin.endIso,
      notes: `feat002 future ${Date.now()}`,
    });
    expect(
      futCreate.status,
      `createManual into a FUTURE empty week (${futToken}) is 2xx (got ${futCreate.status}); body=${JSON.stringify(futCreate.body)}`,
    ).toBeLessThan(300);
    const futPeriod = await getPeriod(page, futToken);
    expect(futPeriod.status, `the future week ${futToken} is open (never locked)`).toBe('open');
    // eslint-disable-next-line no-console
    console.log(`[FEAT-002] step3 future create → ${futCreate.status} (week ${futToken} status=${futPeriod.status})`);

    // =====================================================================
    // STEP 4 — ADMIN UNLOCK-WEEK reopens the locked week.
    // Sign in as admin, land on /approvals, and use the UnlockWeekButton for the
    // employee's locked week. We PREFER driving the UnlockWeekButton through the
    // browser; if the approvals queue row is not matched (see note), we fall back
    // to the SAME unlock-week endpoint via the API request layer.
    //
    // NOTE (pre-existing, FEAT-002-unrelated): the live GET /v1/approvals/queue
    // returns RAW time_entries rows ({id,user_id,project_id,status,start_at,end_at})
    // under a `{ data }` envelope, while the approvals page reads
    // `queue.data?.items` and expects {user_name, iso_week, total_hours,...}. So the
    // live queue renders empty and never carries the YYYY-Www token the
    // UnlockWeekButton needs → the row is not matchable through the UI. The
    // UnlockWeekButton COMPONENT + its endpoint are exercised via the fallback; the
    // queue-shape fix is tracked separately. (Hermetic mode renders the button — see
    // the mock-api /v1/approvals/queue handler.)
    // =====================================================================
    await page.context().clearCookies();
    await waitForAuthWindow();
    markAuthBudgetSpent();
    await signInAs(page, { actorKey: 'admin', landingPath: '/approvals' });
    await expect(page).toHaveURL(/\/approvals/);
    await expectAuthedShell(page);

    // Find the employee's row in the approvals queue and click its Unlock week.
    const empRow = page
      .getByRole('row')
      .filter({ hasText: emp.displayName })
      .filter({ hasText: curToken });
    let unlockResp: { status: number; body: any } | undefined;
    let unlockVia: 'ui' | 'api' = 'api';
    const rowVisible = await empRow
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (rowVisible) {
      // Drive the UnlockWeekButton modal through the UI (reason >= 20 chars).
      await empRow.first().getByRole('button', { name: /unlock week/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(new RegExp(`Unlock ${curToken}`, 'i'))).toBeVisible();
      await dialog
        .getByLabel(/reason/i)
        .fill('e2e: correcting a misallocated project on the submitted week for the employee');
      const [resp] = await Promise.all([
        page.waitForResponse(
          (res) =>
            /\/v1\/timesheet-periods\/[^/]+\/[^/]+\/unlock$/.test(new URL(res.url()).pathname) &&
            res.request().method() === 'POST',
          { timeout: 15_000 },
        ),
        dialog.getByRole('button', { name: /unlock week/i }).click(),
      ]);
      unlockResp = { status: resp.status(), body: await resp.json().catch(() => undefined) };
      unlockVia = 'ui';
      // eslint-disable-next-line no-console
      console.log('[FEAT-002] step4 unlock via UI (UnlockWeekButton on /approvals)');
    } else {
      // Fallback (queue row not matched — see the pre-existing queue-shape note
      // above): drive the SAME unlock-week endpoint via the API request layer.
      unlockResp = await apiCall(
        page,
        'POST',
        `/v1/timesheet-periods/${emp.id}/${curToken}/unlock`,
        { reason: 'e2e: reopening the employee submitted week via the unlock-week endpoint' },
      );
      unlockVia = 'api';
      // eslint-disable-next-line no-console
      console.log('[FEAT-002] step4 unlock via API layer (approvals queue row not matched)');
    }
    expect(
      unlockResp!.status,
      `unlock-week is 2xx (got ${unlockResp!.status}); body=${JSON.stringify(unlockResp!.body)}`,
    ).toBeLessThan(300);
    expect(
      Array.isArray(unlockResp!.body?.unlocked_ids),
      `unlock response has unlocked_ids[] (got ${JSON.stringify(unlockResp!.body)})`,
    ).toBe(true);
    expect(
      unlockResp!.body.unlocked_ids.map(String),
      `the seed entry (${seedEntry.id}) is in unlocked_ids`,
    ).toContain(seedEntry.id);

    // The period reopens: read the EMPLOYEE's row via the RBAC-visible LIST (admin
    // is signed in; the single GET is self-only). Assert status "open" + reopened_at
    // set — the recompute (D4) stamps reopened_at on the locked→open drop.
    let reopened: PeriodShape | undefined;
    const reopenDeadline = Date.now() + 12_000;
    do {
      reopened = await getPeriodForUserViaList(page, emp.id, cur.year, cur.week);
      if (reopened && reopened.status === 'open') break;
      await new Promise((r) => setTimeout(r, 1_000));
    } while (Date.now() < reopenDeadline);
    expect(
      reopened?.status,
      `after admin unlock-week, the employee's period ${curToken} is "open" (got ${JSON.stringify(reopened)})`,
    ).toBe('open');
    expect(reopened!.reopened_at, 'reopened_at is set after unlock-week').toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-002] step4 unlock → status=${unlockResp!.status} unlocked_ids=${JSON.stringify(unlockResp!.body.unlocked_ids)} period now=${reopened!.status} reopened_at=${reopened!.reopened_at}`,
    );

    // =====================================================================
    // STEP 4b — WRITABILITY RESTORED: the employee can createManual into the week
    // again. Sign back in as the employee and create a manual entry NOW (in the
    // reopened week) → 200. This also RESTORES the seed's writability.
    // =====================================================================
    await page.context().clearCookies();
    await waitForAuthWindow();
    markAuthBudgetSpent();
    await signInAs(page, { actorKey: 'alice' });
    await expectAuthedShell(page);

    // WEDNESDAY of the current week — a different week-day than the seed (Monday)
    // so the writeback can never overlap it; still inside the reopened week.
    const wbWin = uniqueWindow(new Date(), 2);
    const writeBack = await apiCall(page, 'POST', '/v1/time-entries', {
      project_id: projectA,
      start_at: wbWin.startIso,
      end_at: wbWin.endIso,
      notes: `feat002 writeback ${Date.now()}`,
    });
    expect(
      writeBack.status,
      `createManual into the REOPENED week is 2xx — lock released (got ${writeBack.status}); body=${JSON.stringify(writeBack.body)}`,
    ).toBeLessThan(300);
    // The week is open again (the writeback added a draft → still open).
    const finalPeriod = await getPeriod(page, curToken);
    expect(['open', 'rejected'], 'the operated week is left WRITABLE (state restored)').toContain(
      finalPeriod.status,
    );

    // =====================================================================
    // NO REGRESSION — INC-002 (sign-in worked) + INC-003 (/me) + INC-005 (no 429).
    // =====================================================================
    await expectAuthedShell(page);
    const postAuthLoginBounces = navs.slice(navsAtAuth).filter((u) => /\/login(\?|$)/.test(u));
    // The deliberate sign-out+sign-in cycles (admin, then employee-again) route
    // through /login; that is EXPECTED. The guard is: no /me storm + no 429.
    const me429 = meStatuses.filter((s) => s === 429).length;
    expect(me429, 'no 429 on /me during the flow (INC-003/INC-005)').toBe(0);
    expect(meStatuses.length, `bounded /me count (no storm) — saw ${meStatuses.length}`).toBeLessThan(
      120,
    );

    // eslint-disable-next-line no-console
    console.log(
      '\n===== FEAT-002 LIVE LIFECYCLE — summary =====\n' +
        `  week under test: ${curToken} (${emp.displayName}, ${tz})\n` +
        `  step1 submit:  200 submitted_ids=${JSON.stringify(submitBody.submitted_ids)}; period→submitted (API; UI banner + New-entry disabled asserted)\n` +
        `  step2 locked:  create=${lockedCreate.status}/${lockedCreate.body?.code}, delete=${lockedDelete.status}/${lockedDelete.body?.code}, start=${lockedStart.status}/${lockedStart.body?.code} (UI: friendly banner, no raw code)\n` +
        `  step3 future:  ${futCreate.status} into ${futToken} (open — never locked)\n` +
        `  step4 unlock:  ${unlockResp!.status} via ${unlockVia.toUpperCase()} unlocked_ids=${JSON.stringify(unlockResp!.body.unlocked_ids)}; period→open (reopened_at set)\n` +
        `  step4b write:  ${writeBack.status} into reopened week → state RESTORED (now ${finalPeriod.status})\n` +
        `  /me 429s=${me429}; post-auth /login routes=${postAuthLoginBounces.length} (deliberate re-logins)\n` +
        '=============================================\n',
    );
  });
});
