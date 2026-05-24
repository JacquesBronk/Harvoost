---
phase: FEAT-002
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Verified FEAT-002 (issue #6 — period/timesheet approval locking, Option F) LIVE against the
freshly-rebuilt Docker stack (web :3000 → api :3001 → Postgres + the HV001 DB lock trigger →
Keycloak :8080). Authored a durable live regression spec
(`tests/e2e/specs/feat002-period-lock.spec.ts`, `chromium-live`) that drives the full lifecycle:
**submit → week locks → PERIOD_LOCKED on writes (create/start) + ENTRY_LOCKED on delete → future-week
still writable → admin unlock-week reopens → writability restored**. Every headline step PASSES; the
spec is re-runnable (ran green twice back-to-back, ~2.7 min each) and leaves state RESTORED (the
operated week ends `open`, reopened_at set). Also confirmed the hermetic `@harvoost/e2e` baseline holds
at **60 pass / 11 fail** with **ZERO new failures** — one FEAT-002-induced hermetic regression
(clock-in submit-week) was found and fixed by updating the mock-api submit handler to the real
`{submitted_ids,skipped}` shape + adding a `/v1/timesheet-periods/{iso_week}` mock handler. FEAT-001
live (timer start/switch/stop + manual) re-verified green (no regression); INC-002/003/005 clean.

# Files touched
- `tests/e2e/specs/feat002-period-lock.spec.ts` (new — the live lifecycle regression spec)
- `tests/e2e/fixtures/mock-api.ts` (modified — submit handler now returns the real
  `{submitted_ids,skipped}` shape; new `GET /v1/timesheet-periods/{iso_week}` handler synthesizing a
  derived rollup so the /timesheets period banner works in mocked mode)
- `tests/e2e/specs/clock-in.spec.ts` (modified — the submit-week success toast assertion now matches
  the new copy "Submitted N entries"; was the stale "Week submitted")

# What downstream agents need to know

## Per-step PASS/FAIL (LIVE, captured statuses)
| Step | What | Result | Captured |
|---|---|---|---|
| 1 | Submit locks the week (`POST /v1/time-entries/{id}/submit {scope:'week'}`) | **PASS** | 2xx (201; NestJS @Post default — NOT 200 as HANDOFF_backend said), body `{submitted_ids:[…42 ids…], skipped:[]}`; seed draft flips to `submitted`; `GET /v1/timesheet-periods/2026-W21` → `status:"submitted"`, `submitted_at` set. **[API for submit + UI for lock rendering]** |
| 1-UI | Locked banner + New-entry disabled | **PASS** | `/timesheets` shows "Week submitted — locked" badge + the friendly explanatory banner; New-entry button DISABLED; Submit-week DISABLED. (Driven by `periodQuery`, independent of the list-bug.) **[UI]** |
| 2a | createManual into locked week | **PASS** | `409 PERIOD_LOCKED`. **[API; UI guard = disabled New-entry]** |
| 2a-UI | Friendly message, no raw code/crash | **PASS** | page shows "you can't add, edit, move, or delete entries in this week"; `PERIOD_LOCKED` raw code count = 0; page still authed. **[UI]** |
| 2b | DELETE an entry in the locked week | **PASS** (nuanced) | `409 ENTRY_LOCKED` (NOT PERIOD_LOCKED) — see "Latent surprise" below. **[API]** |
| 2c | start (NOW() in locked week) | **PASS** | `409 PERIOD_LOCKED`. **[API]** |
| 3 | Future-dating allowed | **PASS** | createManual 8 weeks out → `201`; `GET …/2026-W29` → `status:"open"` (never locked). **[API]** |
| 4 | Admin unlock-week reopens | **PASS** | `POST /v1/timesheet-periods/{user_id}/2026-W21/unlock {reason}` → 2xx (201) `{unlocked_ids:[…], user_id, iso_year, iso_week}`; seed id in `unlocked_ids`; employee period (read via the RBAC list as admin) → `status:"open"`, `reopened_at` set. **[API-layer fallback — UnlockWeekButton not reachable in live UI; see below]** |
| 4b | Writability restored | **PASS** | createManual into the reopened week → `201`; final self period `open`. **State RESTORED.** **[API]** |
| NR | INC-002/003/005 | **PASS** | sign-in round-trips work; `/me` 429s = 0; no /me storm; the 4 post-auth `/login` routes are the DELIBERATE re-logins (employee→admin→employee). |

## Which branches were UI vs API-layer (and WHY)
The dispatch's fallback clause applies — three load-bearing branches are blocked from the live UI by
**pre-existing, FEAT-002-unrelated FE/API envelope drift**, so they are asserted at the API request
layer (the SAME calls the FE issues), while the genuinely-UI-driven surface (the locked banner +
disabled New-entry, which render from the independent `periodQuery`) is asserted through the browser:
- **Submit (step 1):** asserted via API. The live `GET /v1/time-entries` returns `{data}` but
  `timesheets/page.tsx` reads `entriesQuery.data?.items`, so the week table renders EMPTY live →
  `hasDraft` false → the **Submit-week button is DISABLED regardless of FEAT-002**. The button wiring +
  request shape are unchanged; we fire the identical `POST …/submit {scope:'week'}`.
- **Unlock-week (step 4):** asserted via API-layer fallback. The live `GET /v1/approvals/queue` returns
  RAW `time_entries` rows (`{id,user_id,project_id,status,start_at,end_at}`) under `{data}`, while the
  approvals page reads `queue.data?.items` and expects `{user_name, iso_week, total_hours,…}`. So the
  queue renders empty AND never carries the `YYYY-Www` token the `UnlockWeekButton` needs → the row is
  not matchable in the live UI. The spec PREFERS the UI button (tries to match the row first) and falls
  back to the same unlock endpoint. (Hermetic mode DOES render the button — mock-api queue handler.)
- **DELETE / start (step 2b/2c):** API layer by design (no UI delete affordance for a submitted entry;
  forcing a back-dated start through the bar would hit the identical server precheck).
- **Locked banner + New-entry disabled + friendly-message + no-raw-code (steps 1-UI, 2a-UI):** UI.

## Hermetic tally — ZERO new failures
- Baseline (documented): **60 pass / 11 fail** (known WSL `route.fulfill` / strict-mode artifacts).
- After FEAT-002 web changes (BEFORE my mock fix): **59 pass / 12 fail** — ONE new failure:
  `clock-in.spec.ts:94 "submitting transitions draft entries to submitted"`. Root cause: the FEAT-002
  web change made the submit toast title flow through `summarizeSubmitResult(result)`, which reads
  `result.submitted_ids.length`; the mock-api submit still returned `{ok:true}`, so the page threw
  "Cannot read properties of undefined (reading 'length')" → "Submission failed" toast → the test's
  expected "Week submitted" never appeared.
- After my mock-api + spec fix: **60 pass / 11 fail** — back to baseline, ZERO new failures. The 11
  remaining are the unchanged known set (approvals strict-mode locator ×1, auth callback ×1, chatbot
  ×5, csrf ×2, throttle ×1).

## Mock-api / fixture changes (stayed in tests/e2e/)
1. `fixtures/mock-api.ts` submit handler: now returns the contract-faithful
   `{submitted_ids:string[], skipped:[{entry_id,reason}]}` (flips draft→submitted, skips
   running="running" / locked="already_submitted") instead of `{ok:true}`. This is what unblocked the
   clock-in regression — the page consumes the real shape now.
2. `fixtures/mock-api.ts` new `GET /v1/timesheet-periods/{iso_week}` handler: synthesizes a derived
   rollup of the actor's non-running entries (rejected→rejected, all-final→final_approved, no-draft→
   submitted, else open), so the /timesheets locked banner + submit gating work in mocked mode. (The
   page tolerated the prior 404 via `retry:false`, but this makes the mock contract-faithful.)
3. `specs/clock-in.spec.ts`: the success-toast assertion updated from `getByText('Week submitted')`
   to `getByText(/^Submitted \d+ entries$/).first()` to match the new (FEAT-002) toast copy produced
   by `summarizeSubmitResult`.

## State-restoration confirmation
The spec operates on the employee's CURRENT ISO week (2026-W21) and ends by admin-unlocking it back to
`open` + a final writeback, so the week is left WRITABLE. Confirmed in Postgres after the run:
`timesheet_periods` (user_id=3, 2026-W21) → `status='open'`, `reopened_at` set. The SETUP also
auto-resets a leftover-locked week (admin unlock) so an interrupted prior run never wedges re-runs —
verified by two consecutive green runs.

## Latent surprises (worth recording)
1. **DELETE-into-locked-week yields ENTRY_LOCKED, not PERIOD_LOCKED, for a submitted entry.** This is
   CORRECT per HANDOFF_backend's documented ordering (the entry's own-status ENTRY_LOCKED check fires
   FIRST, then the destination-period PERIOD_LOCKED). After a CLEAN week-submit every entry is
   `submitted`, so a DELETE always hits ENTRY_LOCKED first. The PERIOD_LOCKED-on-DELETE "approved
   hardening" only fires for a DELETE of a NON-submitted entry sitting in a week locked by OTHER
   entries — a state a clean week-submit never produces (and you can't createManual a draft INTO a
   locked week — that 409s PERIOD_LOCKED). So the PERIOD_LOCKED-on-DELETE path is effectively
   unreachable via normal lifecycles; it's belt-and-suspenders behind ENTRY_LOCKED. Either way the
   delete is BLOCKED (409) and the locked week is protected. The spec asserts 409 + a lock code ∈
   {ENTRY_LOCKED, PERIOD_LOCKED} and records which fired (ENTRY_LOCKED live).
2. **Submit/unlock return 201, not 200.** NestJS `@Post()` defaults to 201 (no `@HttpCode(200)` on the
   submit/unlock routes); HANDOFF_backend documented "Response 200". The contract body shape is what
   matters; the spec accepts 2xx. Flag for api-designer if the openapi pins 200.
3. **Two pre-existing FE/API envelope drifts surfaced (NOT FEAT-002):** (a) /timesheets reads
   `time-entries .items` but live returns `{data}` → week table empty live (also noted by FEAT-001);
   (b) /approvals reads `queue .items` and expects an enriched row shape, but the live queue returns
   raw entry rows under `{data}` → approvals queue empty live + UnlockWeekButton unrenderable live.
   These block driving submit + unlock through the live UI buttons (worked around via the API layer).
   Recommend tracking as a FE list-envelope reconciliation follow-up — they make the period UI partly
   inert in live mode even though the FEAT-002 backend + the period-status-driven banner work.
4. **Plain employees can't see their own entries/projects live:** `getVisibleProjectIds` scopes to
   MANAGED projects, so a plain employee (bob) gets an empty `/v1/projects` AND an empty
   `/v1/time-entries` (the list ANDs project-visibility). This is why the spec uses Alice (manager +
   employee) as the submitting employee. Possibly a real RBAC gap (employees should see their member
   projects / own entries) but well outside FEAT-002 scope.

# Open questions / unknowns
- None blocking FEAT-002. The latent surprises above (DELETE ordering by design; 201 vs 200; the two
  FE envelope drifts; employee project/entry visibility) are pre-existing or documented behaviors, not
  FEAT-002 regressions. Whether the FE list-envelope drifts and the unlock-week-via-UI reachability are
  in scope to fix is an orchestrator call.

# Verification evidence
- `tsc --noEmit` (tests/e2e) → clean (only pre-existing chatbot.spec `findLast` lib-target errors, untouched).
- `E2E_LIVE=1 … playwright test specs/feat002-period-lock.spec.ts --project=chromium-live --workers=1`
  → **1 passed (2.7m)**, ran green TWICE consecutively (re-runnable + state-restored).
- `E2E_LIVE=1 … playwright test specs/feat001-timer-start.spec.ts --project=chromium-live`
  → **2 passed (1.4m)** — FEAT-001 no regression; timer start NOW in the open week works (no false lock).
- `E2E_SKIP_WEB_SERVER=1 … playwright test --project=chromium-mocked` → **60 passed / 11 failed / 22
  skipped** — documented baseline, ZERO new failures (clock-in submit regression fixed).
- Postgres check post-run: `timesheet_periods (user_id=3, 2026-W21)` → `status=open, reopened_at` set
  (state RESTORED).

# Pinned summary (tight, per step)
- **Step 1 submit→lock: PASS** (201, period→submitted; UI locked banner + New-entry disabled).
- **Step 2 locked writes: PASS** — create=409/PERIOD_LOCKED, start=409/PERIOD_LOCKED, delete=409/ENTRY_LOCKED
  (correct ordering; PERIOD_LOCKED-on-delete unreachable post clean submit); friendly UI message, no raw code, no crash.
- **Step 3 future-dating: PASS** (201 into W+8, period open — never locked).
- **Step 4 admin unlock-week: PASS** (201, period→open + reopened_at; writeback 201 → writable; state RESTORED).
- **Hermetic: PASS** — 60/11 baseline, zero new failures (mock-api submit shape + period GET handler added; clock-in toast assertion updated).
- **No-regression: PASS** — FEAT-001 live green; INC-002/003/005 clean (no /me 429, no storm, no post-auth bounce loop).
