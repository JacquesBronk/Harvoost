---
phase: FEAT-002
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
RE-verified FEAT-002 (issue #6) LIVE after the expansion that fixed the UI-button inertness, against
the freshly-rebuilt Docker stack (web :3000 → api :3001 → Postgres + the HV001 DB lock trigger →
Keycloak :8080). The three previously-blocking FE/API drifts are now FIXED in the running stack and the
headline buttons work END TO END through the live browser: **Submit-week works for a PLAIN EMPLOYEE
(bob)**, and **admin Unlock-week works from the enriched /approvals queue**. Rewrote
`tests/e2e/specs/feat002-period-lock.spec.ts` to drive submit + unlock through the actual UI BUTTONS
(no API-layer fallback for the buttons) using bob as the submitting employee. The lifecycle PASSES
end-to-end and is re-runnable + state-restoring (ran green TWICE consecutively; leaves bob's week
`open`/`reopened`). Hermetic `@harvoost/e2e` holds at the documented **60 pass / 11 fail** baseline with
ZERO new failures (updated two mock-api handlers to the now-fixed `{data}` envelope). FEAT-001 timer,
INC-006 admin-users, and INC-007 drill-ins re-verified green live; no /me 429 storm.

# Files touched
- `tests/e2e/specs/feat002-period-lock.spec.ts` (modified — now drives Submit-week + Unlock-week through
  the live BROWSER buttons with bob the PLAIN EMPLOYEE; adds setup determinism + dynamic future-week scan)
- `tests/e2e/fixtures/mock-api.ts` (modified — `GET /v1/time-entries` and `GET /v1/approvals/queue` now
  return the `{ data }` envelope the FEAT-002-fixed pages read; `items` kept as a duplicate alias)

# What downstream agents need to know

## Per-step PASS/FAIL (LIVE, UI buttons, captured)
| Step | What | Result | Evidence |
|---|---|---|---|
| 1 | Plain employee (bob) sees + SUBMITS the week via the **UI button** | **PASS** | bob's picker returns his member projects (1,2); the week ENTRY TABLE renders his entries (NOT empty — (a) fix); Submit-week button **ENABLED** (was permanently disabled); CLICK → POST `/submit {scope:'week'}` → 200, `submitted_ids` includes the seed; success toast **"Submitted N entries"**; week flips to **"Week submitted — locked"** banner; New-entry + Submit-week DISABLED; period→`submitted` (submitted_at set). |
| 2 | PERIOD_LOCKED via the UI | **PASS** | New-entry button DISABLED; page shows friendly "you can't add, edit, move, or delete entries in this week"; raw `PERIOD_LOCKED` code count = 0; no crash. Server cross-checks: create=**409/PERIOD_LOCKED**, start=**409/PERIOD_LOCKED**, delete=**409/ENTRY_LOCKED** (documented ordering — entry's own-status check fires first). |
| 3 | Future-dating still allowed | **PASS** | createManual into a dynamically-scanned OPEN future week → **201**; that week stays `open` (never locked) while W21 is locked. |
| 4 | Admin UNLOCK-WEEK via the **UI button** | **PASS** | /approvals queue RENDERS enriched rows (user name + ISO-week token + hours — (c) fix; NOT "Inbox zero"); bob's row for the locked week matched; clicked **UnlockWeekButton** → modal (reason ≥20 chars) → submit → POST `/unlock` → 200, `unlocked_ids` includes the seed; success toast **"Week unlocked"**; bob's period → `open` (reopened_at set). |
| 4b | Writability restored / state RESTORED | **PASS** | bob createManual into the reopened week → **201**; final W21 period `open`. Postgres confirms `timesheet_periods(user_id=6, 2026-W21) = open, reopened_at set`. |
| NR | INC-002/003/005 | **PASS** | sign-ins work; `/me` 429s = 0; no /me storm; the post-auth `/login` routes are the deliberate re-logins (bob→[admin reset]→bob→admin→bob). |

## Does bob (the PLAIN EMPLOYEE) now work for submit? YES.
The (b) `self_anchored` RBAC fix is live and confirmed at the API layer (probe): bob (user_id=6,
role=employee) gets `GET /v1/projects` → `{data:[P1(id=1),P2(id=2)]}` (his member projects) and
`GET /v1/time-entries` → his OWN draft entries (`scope_meta.visible_users:1, visible_projects:2`). So a
plain employee's /timesheets picker + week table + Submit-week button all work end-to-end. **No fallback
to Alice was needed** — the whole lifecycle ran on bob.

## Queue render + UI unlock confirmation
The (c) fix is live: `GET /v1/approvals/queue?stage=manager` returns enriched per-(user, ISO-week)
`ApprovalQueueItem` rows (`{id,user_id,user_name,iso_week:"YYYY-Www",total_hours,status,submitted_at}`)
under `{data}`, and the page reads `.data`. As admin, the queue table renders bob's row, the per-row
`UnlockWeekButton` is reachable, the modal opens, and the unlock POST fires from the button. The
unlock-week button now works END TO END in the live browser (was unreachable before).

## The buttons work END TO END (explicit)
- **Submit-week button:** YES — clicked through the live browser by a PLAIN EMPLOYEE (bob); locked the
  week; success toast + locked banner + disabled controls all rendered from the real response.
- **Unlock-week button:** YES — clicked through the live browser by admin from the enriched /approvals
  queue row; reopened the week; success toast rendered; period verified `open` + reopened_at.

## Hermetic tally — ZERO new failures
- The FEAT-002 web change (pages now read `.data`) broke TWO hermetic specs because the mock still
  returned `{items}`: `clock-in.spec.ts:88` ("Submit week enabled…") + `clock-in.spec.ts:94`
  ("submitting transitions…") went red, and `approvals.spec.ts:9` rendered empty — measured **58 pass /
  13 fail** before my mock fix.
- I updated the mock-api `GET /v1/time-entries` and `GET /v1/approvals/queue` handlers to the `{ data }`
  envelope (keeping `items` as a duplicate alias). After the fix: **60 pass / 11 fail / 22 skipped** —
  exactly the documented baseline, **ZERO new failures** (ran twice, stable). The remaining 11 are the
  unchanged known set: `approvals.spec.ts:9` (pre-existing `getByText('Submitted')` strict-mode locator
  artifact — the queue NOW renders bob's row + status badge, so this is purely the locator, not an
  envelope failure), auth callback ×1, chatbot ×5, csrf ×2, throttle ×1.

## Mock-api changes (stayed in tests/e2e/)
1. `GET /v1/time-entries` → returns `{ data: items, items, page, page_size, total_count, next_cursor }`
   (was `{ items, next_cursor }`). The /timesheets table reads `entriesQuery.data?.data`.
2. `GET /v1/approvals/queue` → returns `{ data: items, items, next_cursor }` (was `{ items, next_cursor }`).
   The /approvals queue reads `queue.data?.data`.

## State restoration
The lifecycle operates on bob's CURRENT ISO week and ends with the admin UI-unlock reopening it +
a writeback, so W21 is left WRITABLE. Verified in Postgres post-run:
`timesheet_periods(user_id=6, 2026-W21) = open, reopened_at set`. SETUP is self-healing: it (i) flushes
leftover non-current-week drafts and (ii) auto-unlocks a leftover-locked current week, then step 3 scans
forward for a fresh OPEN future week. Proven re-runnable — two consecutive green live runs.

# Open questions / unknowns
- **Pre-existing FE/API list-filter param drift (NOT FEAT-002, but newly OBSERVABLE post-(a)):** the
  /timesheets page sends `start_at_from`/`start_at_to` to `GET /v1/time-entries`, but the backend
  `ListQuery` only honours `date_from`/`date_to`, so those params are IGNORED — the "week" table actually
  lists ALL of the user's entries (newest-first, limit 200). Before the (a) fix the table was empty so
  this was invisible; now that it renders, the **Submit-week button anchors on `entries[0]` (the newest
  draft, possibly in a DIFFERENT week)** — with a stale FUTURE-week draft present it can submit/lock the
  WRONG week (I hit exactly this on a re-run: it locked W29 instead of W21). FEAT-002's lock state machine
  is unaffected (the week-submit, lock, and unlock are all correct); this is a list-FILTERING drift,
  sibling to the `.items`/`.data` envelope drift. The spec works around it deterministically (SETUP
  flushes stray-week drafts so the anchor is always a current-week draft, and week-submit then submits ALL
  current-week drafts). **Recommend a follow-up:** either rename the FE params to `date_from`/`date_to`
  or add `start_at_from`/`start_at_to` to the backend `ListQuery` + WHERE, so the /timesheets week view
  shows only the selected week and the Submit-week button always targets the displayed week.
- **Submit/unlock now return 200 (not 201) live.** The previous reverify saw 201; this run saw 200 on
  both submit and unlock — the routes appear to have `@HttpCode(200)` now. The spec accepts any 2xx, so
  this is harmless; flag for api-designer only if the OpenAPI pins one or the other.

# Verification evidence
- bob probe (live): `GET /v1/projects` → `{data:[{id:1,P1},{id:2,P2}]}`; `GET /v1/time-entries` → bob's
  own drafts, `scope_meta.visible_projects:2` — the (b) self-scope fix works for a plain employee.
- `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 playwright test specs/feat002-period-lock.spec.ts --project=chromium-live --workers=1`
  → **1 passed** (ran green TWICE consecutively: 5.4m then 2.7m — re-runnable + state-restored).
- `E2E_SKIP_WEB_SERVER=1 playwright test --project=chromium-mocked`
  → **60 passed / 11 failed / 22 skipped** (documented baseline, ZERO new failures; stable across 2 runs).
- `E2E_LIVE=1 … playwright test specs/feat001-timer-start.spec.ts --project=chromium-live` → **2 passed**
  (timer start/switch with task — no regression).
- `E2E_LIVE=1 … playwright test specs/inc006-admin-users.spec.ts specs/inc007-drillin-rollup.spec.ts --project=chromium-live`
  → **3 passed** (admin /users renders; employee + project drill-ins send default date_range, rollup 200,
  render with no error surface).
- `tsc --noEmit` (tests/e2e) → clean for `feat002-period-lock.spec.ts` (only the pre-existing chatbot.spec
  `findLast` lib-target errors remain, untouched).
- Postgres post-run: `timesheet_periods(user_id=6, 2026-W21) = open, reopened=t` (state RESTORED).

# Pinned summary (tight, per step)
- **Step 1 (UI submit, PLAIN EMPLOYEE bob): PASS** — table renders bob's entries, Submit-week ENABLED,
  clicked in-browser → 200, "Submitted N entries" toast, locked banner, New-entry disabled, period→submitted.
- **Step 2 (PERIOD_LOCKED via UI): PASS** — New-entry disabled + friendly message + no raw code; server
  create/start=409 PERIOD_LOCKED, delete=409 ENTRY_LOCKED.
- **Step 3 (future-dating): PASS** — 201 into an OPEN future week; never locked.
- **Step 4 (admin UI unlock): PASS** — enriched queue RENDERS bob's row, UnlockWeekButton clicked
  in-browser → 200, "Week unlocked" toast, period→open (reopened_at).
- **Step 4b + restore: PASS** — writeback 201; W21 left open (Postgres-verified).
- **Hermetic: PASS** — 60/11 baseline, ZERO new failures (mock-api `{data}` envelope for time-entries +
  approvals queue).
- **No-regression: PASS** — FEAT-001 live, INC-006, INC-007 green; no /me 429 storm.

> **Bottom line:** Both the Submit-week and the Unlock-week buttons now work END TO END in the live UI —
> Submit by a PLAIN EMPLOYEE (bob), Unlock by admin from the enriched approvals queue. All four steps
> PASS live through the real browser buttons.
