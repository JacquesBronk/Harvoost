---
phase: 05-test/e2e
agent: e2e-tester
started: 2026-05-23
finished: 2026-05-24
status: complete
---

# Summary
Executed and hardened the never-run FEAT-001 live e2e spec against the live docker stack
(web :3000 → api :3001 → Postgres → Keycloak :8080, all `localhost`). First execution
surfaced three test-fixture bugs in the never-executed live spec (a switch-panel
`selectOption` detach race, mutation submits not tolerant of the global 300/60s limiter, and
a buggy unique-slot derivation for the manual entry that always collided). All three are now
fixed **inside `tests/e2e` only** — no `apps/web` / `apps/api` source touched. The headline
criterion PASSES live and was confirmed across **three independent clean green runs**: after
starting a timer from /timesheets, `GET /v1/time-entries/running` returns the new entry under
`{ data }` AND the TimerBar shows Running + project + ticking elapsed (the running-envelope
reconciliation). Manual-create, switch (re-point without stop), and stop all verified. The
hermetic `clock-in.spec.ts` (frontend lane's dead-link fix) passes 7/7. FEAT-001 added **zero**
new hermetic failures and FIXED the 5 old clock-in failures. INC-002/INC-003 confirmed clean
(no `/login` bounce, no `/me` 429 storm; oidc-flow.spec.ts 5/5 green).

# Files touched
- `tests/e2e/specs/feat001-timer-start.spec.ts` (modified — fixture hardening only; this is the
  only file I edited. `mock-api.ts` and `clock-in.spec.ts` were authored by the frontend lane
  and were NOT modified by me.)

## Fixture fixes made (file + what + why)
All in `tests/e2e/specs/feat001-timer-start.spec.ts`:

1. **Switch-panel `selectOption` detach race → `selectOptionStable()` helper (new).**
   - *What:* Replaced the bare `switchPanel.getByLabel('Switch to project').selectOption(...)`
     (and the inline start picker's `selectOption`) with a retry helper that re-resolves the
     locator, waits for visible+enabled, selects, and asserts `toHaveValue(value)` as the
     success condition; retries on detach.
   - *Why:* First run failed with `element was detached from the DOM, retrying` → timeout. The
     TimerBar polls `GET /running` every 10s and the switch panel's `StartTimerControl`
     independently refetches `GET /v1/projects`; either refetch briefly falls back to its
     `LoadingSpinner` early-return, unmounting the `<select>` for a frame exactly while
     Playwright's `selectOption` is acting. App re-render race, not an app bug — the picker
     re-mounts immediately. (trace network confirmed the concurrent `/running` + `/projects` GETs.)

2. **Switch-panel projects-query 429 error state → reuse `ensurePickerReady()` on the switch panel.**
   - *What:* Before selecting in the switch panel, call the spec's existing `ensurePickerReady`
     (clicks the app's own "Retry") so the panel recovers from its in-component error state.
   - *Why:* Under global-limiter pressure the switch panel's `GET /v1/projects` 429'd, so the
     control rendered its `role="alert"` + "Retry" path INSTEAD of the `<select>`
     (snapshot showed `alert: "You are sending requests too quickly"`). The inline card already
     had this recovery; the switch panel now has parity.

3. **Mutation submits not 429-tolerant → `submitMutationWithRetry()` helper (new) + manual-create retry loop.**
   - *What:* start / switch / stop submits now go through a helper that clicks, awaits the
     matching POST response, and retries on a 429 (≈12s backoff × 8 ≈ a full fixed-window). The
     manual-create submit got the same loop inline (the NewEntryForm modal stays open on error).
   - *Why:* start/switch/stop/manual-create all run through the app's `apiFetch`, sharing the
     global **300/60s** limiter with every GET this spec (and the bar's background polls) fire.
     Under repeated re-runs the bucket momentarily drains and the app's own POST legitimately
     returns 429 (NOT an app bug — the ThrottlerGuard doing its job). A 429 is rejected before
     the handler, so re-clicking is safe and never double-commits. A real 4xx/5xx never recovers
     to 2xx and still surfaces.

4. **Manual-entry unique-slot derivation was buggy (always overlapped) → fixed-anchor + epoch-minute offset.**
   - *What:* The original `% 240` band (and my interim `minutesAgo`-from-now form) mapped many
     distinct epoch-minutes to the SAME absolute slot, so re-runs 400'd with
     `VALIDATION_FAILED "Overlapping time entry"`. Rewrote to: `start = (60-days-ago 00:00) +
     (epochMinute % 28800) minutes` — each distinct epoch-minute → a distinct absolute minute,
     60 days in the past (clear of the live timer and any viewer-TZ skew).
   - *Why:* The dev stack has no DELETE affordance, so every run persists its draft; a colliding
     slot 400-overlaps on the next run. The new mapping needs two runs at the same
     epoch-minute-mod-28800 (~20 days apart to the minute) to collide — never in practice.

# What downstream agents need to know
- **HEADLINE PASSED LIVE.** Across 3 clean runs the started timer surfaced in the TimerBar via
  the `{ data }` envelope. Observed `GET /running` payloads (last clean run):
  - step1 manual: `id=30 status=draft` (notes "e2e manual …") — appears in `GET /v1/time-entries`.
  - step2 start:  `{ data: { id:31, project_id:"1", status:"running", … } }` → bar shows Running
    + `Project #1` (the live `/running` omits `project_name`, so the bar renders its documented
    `Project #<id>` fallback) + ticking elapsed.
  - step3 switch: `{ data: { id:32, project_id:"2", status:"running" } }` — re-pointed to a
    different project, STILL running (no stop between). Switch body used `project_id` (NOT the
    spec's `new_project_id`); carried an Idempotency-Key.
  - step4 stop:   `{ data: null }` — bar back to idle "No active timer" + Start affordance.
  - INC guards: `/me statuses: [200] (429s=0); post-auth /login bounces=0`.
  - (Two earlier clean runs gave the identical shape with ids 18/19/20 and 27/28/29 —
    re-runnable: each run stops any pre-existing timer at setup and scopes assertions to the
    ids it creates.)

- **CONFIRMED REAL APP BUG (pre-existing, out of FEAT-001 scope, documented loudly in the spec —
  NOT papered over): `task_id` cast 500.** Selecting a task and starting/switching with
  `task_id` set makes `POST /v1/time-entries/start` (and `/switch`) **500** with Prisma
  `42804: column "task_id" is of type bigint but expression is of type text`. Confirmed in the
  live api logs at `time-entries.controller.ts:173` — the INSERT binds `task_id` as `$3` with NO
  `::bigint` cast (unlike `project_id` which has `$2::bigint`). The spec deliberately starts
  PROJECT-ONLY (the guaranteed valid path) and only asserts the optional task picker *renders* +
  offers the seeded "General" task (proving the new `GET /v1/projects/{id}/tasks` read endpoint is
  live), leaving it unselected. **Recommended follow-up:** add `::bigint` casts to the `task_id`
  bind in the start/switch/createManual INSERTs (a one-line backend fix, separate issue).

- **THROTTLE PACING is the operational constraint for re-runs, not a defect.** The live auth
  limiter is **5/60s shared across idp-info + oidc/login + oidc/callback + /me**, and the global
  limiter is **300/60s**. Running this heavy spec back-to-back saturates them and a sign-in or a
  mutation 429s mid-flow (exactly the behaviour `oidc-flow.spec.ts` documents as CORRECT product
  behaviour). **Run feat001-timer-start one-per-window: leave ≥ ~90s of quiet between separate
  process invocations** (its in-process `beforeEach` paces multiple tests, but a fresh process
  can't see the prior process's budget). All my intermediate failures were this contention from a
  heavy iteration session — never a spec/app defect (proven by 3 clean greens once buckets rested).

- **Pre-existing list-envelope drift (already flagged by frontend lane, untouched):**
  `GET /v1/time-entries` returns `{ data }` live but `apps/web/app/timesheets/page.tsx` reads
  `entriesQuery.data?.items`, so the week TABLE renders empty in live mode. The manual-create
  JOURNEY (form → POST → DB) is fully proven via the API; only the table display is blocked by
  that separate, out-of-scope drift. Not a FEAT-001 regression.

# Open questions / unknowns
- None blocking FEAT-001. The `task_id` cast 500 is a real but pre-existing/out-of-scope backend
  bug (worked around by project-only start, as the spec intends); flagged above for follow-up.

# Verification evidence
- **Live spec (headline):** `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test
  specs/feat001-timer-start.spec.ts --project=chromium-live --workers=1` → **PASS** (1/1),
  reproduced cleanly **3×** (ids 18/19/20, 27/28/29, 30/31/32) on fresh auth windows. All five
  acceptance steps verified (manual + end≤start block-no-API; start `{ data }` + bar Running +
  ticking; switch re-point still-running with `project_id`; stop `{ data: null }`; no regression).
- **Hermetic clock-in (frontend dead-link fix):** `pnpm exec playwright test specs/clock-in.spec.ts
  --project=chromium-mocked` → **PASS 7/7**. The idle TimerBar shows "No active timer" + a real
  "Start timer" button; the dead `/start one from timesheets/i` link is GONE (count 0); the panel
  opens to the StartTimerControl Project picker.
- **Hermetic baseline (new vs pre-existing):**
  - With FEAT-001: full `chromium-mocked` suite = **60 passed / 11 failed / 14 skipped**.
  - Pre-FEAT-001 baseline (FEAT-001 e2e changes stashed): **55 passed / 16 failed / 13 skipped**.
  - **FEAT-001 added ZERO new hermetic failures** and FIXED the **5 old `clock-in.spec.ts`**
    failures (replaced by 7 new passing). The **11 remaining failures are PRE-EXISTING and
    IDENTICAL** in both runs: `approvals`(1), `auth`(1), `chatbot`(6), `csrf`(2), `throttle`(1).
    Root cause is a shared **hermetic-infra / Playwright-1.60.0-in-WSL artifact**: the mock-api's
    `route.fulfill` `Set-Cookie` is not applied (auth callback → `Set-Cookie: null`), and the
    raw `page.evaluate(fetch)` CSRF/throttle-origin behaviour differs (csrf expects 403 → gets
    201; throttle expects ≥1 429 → gets 0). These specs were untouched by FEAT-001 and are
    documented as passing in the original CI environment — an environment artifact, not a
    FEAT-001 regression.
- **INC regression:** `oidc-flow.spec.ts --project=chromium-live` → **PASS 5/5** (INC-002 round-trip
  + sub-claim stability). The feat001 live flow's `/me statuses: [200] (429s=0); post-auth /login
  bounces=0` confirms INC-003 (no /me storm) and INC-002 (no post-auth bounce) clean.
- **Confirmed real backend bug** (evidence): live api log
  `PrismaClientKnownRequestError … Code: 42804 … column "task_id" is of type bigint but expression
  is of type text … time-entries.controller.ts:173` — only triggered when a task is selected;
  project-only start/switch return 201 + correct running envelope.

---

# Task-select live re-verify (2026-05-24) — `task_id` bigint-cast 500 fix

The previously-flagged backend bug (Prisma 42804 `column "task_id" is of type bigint but
expression is of type text` on task-select start/switch) is **FIXED**: the start + switch + manual
INSERTs in `apps/api/src/time-entries/time-entries.controller.ts` now cast `$3::bigint`, and the
`harvoost-api` container was rebuilt (Up, healthy). Re-verified live through the real browser.

**Change (additive, `tests/e2e` only):** added ONE new case to
`tests/e2e/specs/feat001-timer-start.spec.ts` —
`"Alice can start (and switch) a timer WITH a task selected — task_id persists, no 500"` — within
the existing serial describe, reusing the existing auth + `selectOptionStable` /
`ensurePickerReady` / `submitMutationWithRetry` / `getRunning` / `waitForRunning` helpers. It signs
in as Alice, stops any pre-existing running timer, then on `/timesheets`: picks a project, waits for
the OPTIONAL task picker to enable (GET `/v1/projects/{id}/tasks`), selects the project's "General"
task, presses Start; then opens Switch, picks a different project + its task; then Stops to clean up.
No `apps/web` / `apps/api` source touched.

**Result: PASS.** Selecting a task on start AND switch now returns 2xx (NOT 500) with the chosen
`task_id` persisted, live in the browser:

| transition       | HTTP | GET /running (browser session)                                                                 |
|------------------|------|------------------------------------------------------------------------------------------------|
| start-with-task  | 201  | `{ data: { id:69, project_id:"1", task_id:"1", status:"running", … } }`                         |
| switch-with-task | 201  | `{ data: { id:70, project_id:"2", task_id:"2", status:"running", … } }`                         |
| stop (cleanup)   | 2xx  | `{ data: null }`                                                                                |

(NestJS `@Post('switch')` returns **201** by default — no `@HttpCode(200)` override — so the case
asserts switch is 2xx and explicitly NOT 500, rather than a literal 200. start is genuinely 201.)
`task_id` is a Postgres bigint serialized as a STRING (`BigInt.prototype.toJSON`, `main.ts`), so the
assertion compares the picker's string option value to `String(running.task_id)`.

**Run command (confirmed against `playwright.config.ts`):**
`E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test specs/feat001-timer-start.spec.ts --project=chromium-live --workers=1`

**Full-file outcome:** both cases pass together in serial — `2 passed (4.3m)`. The original headline
case ("manually log, start, switch, stop") still PASSES unchanged (start id=67 → switch id=68 →
stop data:null; `/me [200] 429s=0`, post-auth /login bounces=0). No flakiness observed across 3 live
runs (project-only and task-select each green more than once). No `500` seen anywhere; if it had
appeared, the case fails loudly with the response body inlined in the assertion message.
