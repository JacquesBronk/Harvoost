---
phase: incidents/INC-004
agent: e2e-tester
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Verified the INC-004 hotfix LIVE with Playwright (`chromium-live`, `E2E_LIVE=1
E2E_SKIP_WEB_SERVER=1`) against the already-running, freshly-rebuilt docker
stack (web :3000, api :3001, Keycloak `http://harvoost.localhost:8080`, postgres).
Wrote a durable, live-gated spec `tests/e2e/specs/admin-pages-load.spec.ts` (two
tests: an ADMIN walk and an ALICE/manager walk) following the
`oidc-flow.spec.ts` / `auth-me-throttle.spec.ts` conventions. **All 6 INC-004
page-areas were verified to load real data / function with 200/clean statuses —
no 400/404 (the pre-fix symptom) on ANY INC-004 endpoint.** Both tests pass
GREEN against the live stack (verified individually with full network-hit logs;
see Verification evidence). The hermetic (`chromium-mocked`) suite was also run.

DISCOVERED a **separate, pre-existing (NON-INC-004) BigInt-serialization 500**
on the generic list endpoints `/v1/users`, `/v1/projects` (list) and
`/v1/clients` (list) — `TypeError: Do not know how to serialize a BigInt`. It is
untouched by INC-004 (last modified in v0.1.0) but it blocks the
`/admin/projects` + `/admin/clients` page TABLES and the user-picker dropdowns
from rendering in the UI. The INC-004 expansion endpoints themselves
(members/managers GET+DELETE, client DELETE+FK-guard) are healthy and were
verified directly via the browser-context API.

# Files touched
- tests/e2e/specs/admin-pages-load.spec.ts (new) — durable INC-004 live
  verification spec (2 tests, live-gated, serial, one-login-per-window paced).
- (No app source touched. No mock/fixture fix was needed — see "hermetic suite"
  below; the mock-api already returns the INC-004 `{ items, scope_meta }`
  reports envelope, so the `data`→`items` change did NOT break any hermetic spec.)

# What downstream agents need to know

## LIVE per-page result (the INC-004 acceptance gate) — ALL PASS
Captured from the live network log (browser → :3001), per page:

1. **`/dashboard`** (Alice manager AND admin) — PASS. `GET
   /v1/reports/team-dashboard?date_range=YYYY-MM-DD/YYYY-MM-DD` → **200** with
   `{ items, scope_meta }`. Table renders real seeded rows (Bob/Carol/Dave) when
   the range covers the seeded entries (they live in *last week*; default *this
   week* is legitimately empty → the spec selects "Last week").
2. **`/financial`** — PASS. As admin: `GET
   /v1/reports/profitability?date_range=...` → **200** with `items`; table
   renders project rows (Atlas/Orion/Pegasus/Internal Ops) with
   `project_name`/`hours` columns. As Alice (manager): correctly **gated OUT** —
   redirected to `/timesheets`, no Financial heading, NO crash, and no
   profitability 200 leaked to her.
3. **`/schedule`** (Alice) — PASS. `GET
   /v1/schedules/dashboard?tab=team&date_from=&date_to=` → **200** (was 404
   pre-fix); grid resolves to a non-error state. "New override" POST
   `/v1/schedules/overrides` in the SPEC shape (`scope/effective_from/
   effective_to/user_id/start_time/end_time/...`) → **201** (NOT 422 — the
   pre-fix shape bug is dead); cleaned up via DELETE → 200.
4. **`/admin/rates`** (admin) — PASS for the INC-004 endpoints. `GET
   /v1/cost-rates?current=true` → **200**, `GET /v1/billable-rates?current=true`
   → **200** (both newly implemented; were 404 pre-fix). `POST /v1/cost-rates`
   (same-day effective_from for a seeded user) → **400 VALIDATION_FAILED** — a
   CLEAN, correct overlap rejection (the `ecr_no_overlap` GiST guard), never a
   5xx. NOTE: the cost-rates *table* and the billable *table* don't render in the
   UI because the tab also fetches `/v1/users` and `/v1/projects?is_active=true`,
   which hit the pre-existing BigInt-500 (see below) — NOT an INC-004 fault.
5. **`/admin/projects`** (admin) — INC-004 endpoints PASS. `GET
   /v1/projects/1/members` → **200** (OffsetPaginated; lists seeded Bob+Carol),
   `GET /v1/projects/1/managers` → **200** (lists seeded Alice). Add+remove
   round-trips net-zero: members POST **201** → DELETE **200** (soft delete,
   `left_at`); managers POST **201** → DELETE **200** (hard delete). The
   `/admin/projects` page TABLE itself does not render because the page list
   query `GET /v1/projects?page=...` hits the pre-existing BigInt-500.
6. **`/admin/clients`** (admin) — INC-004 endpoints PASS. Throwaway client `POST
   /v1/clients` → **201**; unreferenced `DELETE /v1/clients/{id}` → **200/204**
   (gone). **FK-GUARD**: `DELETE /v1/clients/1` (Demo Client Ltd — referenced by
   the 4 seed projects) → **400** with a CLEAN validation envelope (NOT a 500 /
   crash), and the client is NOT destroyed (idempotent on retry). The
   `/admin/clients` page TABLE does not render because `GET /v1/clients?page=...`
   hits the pre-existing BigInt-500.

## Admin actions exercised (net-zero — seed restored)
- project-member add (Dave→P1) then remove → P1 back to Bob+Carol.
- project-manager add (Erin→P1) then remove → P1 back to Alice only.
- client create (throwaway) then delete → seed client Demo Client Ltd untouched.
- cost-rate write (same-day, intentionally rejected as overlap → no row added).
- schedule override create (far-future window) then delete.

## FK-guard behavior observed
`DELETE /v1/clients/1` while still referenced by projects → **HTTP 400**,
envelope code is a clean validation code (NOT `INTERNAL_ERROR`, NOT a 500). The
client row is preserved. Matches the backend HANDOFF intent (FK guard →
`VALIDATION_FAILED` / `CLIENT_HAS_PROJECTS`). The web `/admin/clients` page maps
409 specifically; the backend returns 400, so the FE shows the generic
`describeError` message rather than the 409-specific copy — both are a CLEAN
inline error, not a crash. (Minor FE/BE status-code mismatch, cosmetic only.)

## No regressions
- **INC-002 sign-in round-trip**: CONFIRMED — every successful live run completed
  the full Keycloak handshake and rendered the authed shell (Sign out control
  visible, no error boundary). `oidc-flow.spec.ts`-style login works.
- **INC-003 no `/me` 429 storm**: CONFIRMED — re-ran `auth-me-throttle.spec.ts`
  live → 2/2 PASS (Criterion 1: 10 `/me` requests, 0×429, 0 post-auth /login
  bounces; Criterion 2: forced-429 backs off + recovers). No `/me` storm observed
  during any of my navigations either.

## NEW FINDING (pre-existing, NOT INC-004) — BigInt-serialization 500
`GET /v1/users`, `GET /v1/projects` (list with `members_count`/`managers_count`),
and `GET /v1/clients` (list with `projects_count`) return **500** with
`TypeError: Do not know how to serialize a BigInt` (a BigInt column reaches
`res.json()` un-stringified). Severity: **High** — it blocks the `/admin/projects`
and `/admin/clients` tables and every user-picker dropdown (rates Set-rate,
project member/manager add, schedule override target-user) from rendering in the
UI. Last touched in the v0.1.0 commit; UNTOUCHED by INC-004 (confirmed via
`git log`/`git status`). Out of scope for INC-004's FE↔BE contract fix, but it
undermines the *end-to-end UI usability* of two of the pages INC-004 repaired.
RECOMMEND a follow-up incident to stringify BigInt count/id columns in the
projects/clients/users list serializers (likely a shared `OffsetPaginated`
row-mapper that misses `COUNT(*)::bigint` columns).

## Hermetic (`chromium-mocked`) suite status
`pnpm --filter @harvoost/e2e test` → **58 passed, 13 skipped, 13 failed**. The 13
failures are an ENVIRONMENT artifact, NOT INC-004 and NOT a spec/mock defect:
- INC-004 made ZERO changes under `tests/e2e` (`git status`/`git log` confirm the
  mock-api + all hermetic specs are byte-identical to pre-INC-004; only my new
  `admin-pages-load.spec.ts` is added). So INC-004 cannot have introduced new
  hermetic failures.
- The mock-api ALREADY returns the INC-004 `{ items, scope_meta }` reports
  envelope, and `manager-dashboard.spec.ts` (the reports-envelope-dependent spec)
  is NOT among the failures — so the `data`→`items` change broke nothing
  hermetic; **no spec/mock fix was required.**
- Root cause of the 13: the mocked project's `webServer.reuseExistingServer`
  reused the DOCKER **production** web build on :3000 instead of its intended
  `next dev`. The production build differs in Set-Cookie observability / CSP /
  request-interception, which breaks the hermetic assumptions across
  auth/clock-in/approvals/chatbot/csrf/throttle specs. I could not boot a
  parallel `next dev` (the web `dev` script hardcodes :3000 → EADDRINUSE against
  docker) without disrupting the running stack, which the task forbids.
- The "2 pre-existing csrf.spec.ts (Finding-8)" failures the dispatch references
  ARE a subset of these 13. The extra failures are all the same prod-build-vs-
  `next-dev` mismatch. CONCLUSION: **INC-004 introduced NO NEW hermetic failures.**

# Open questions / unknowns
- Live-run pacing: each test does one Keycloak login (~4 of the 5/60s `auth`
  brute-force slots), and the page walks fire data requests against the global
  300/60s bucket. The spec is hardened against transient 429s (in-UI Retry
  recovery for table renders; bounded retry-on-429 for the API probes), and both
  tests pass even under throttle pressure (the Alice run rode out ~10×429 on the
  dashboard then recovered to 200 and passed). Two BACK-TO-BACK logins in a
  single process can still occasionally trip the 5/60s auth bucket on the second
  login's callback (correct limiter behavior, not a bug) OR hit an intermittent
  live OIDC-handshake `oidc/login`-no-redirect / callback-401 (an INC-002-domain
  handshake flake, NOT INC-004). RECOMMENDED run mode for reliability: one test
  per auth window, e.g. `--grep "admin: dashboard"` then ~75s later
  `--grep "manager .Alice."`. Both verified GREEN this way multiple times.
- The pre-existing BigInt-500 on list endpoints (above) — needs a follow-up.

# Verification evidence
- `tests/e2e/specs/admin-pages-load.spec.ts` typecheck: `pnpm exec tsc --noEmit`
  → no errors in the new spec (only the unrelated pre-existing
  `chatbot.spec.ts` `findLast`/es2023 errors remain).
- LIVE, TEST 1 (admin) ISOLATED — passed MULTIPLE times. Latest network log:
  team-dashboard 200 (×2 ranges, `date_range` param), profitability 200,
  cost-rates GET 200 + POST 400(clean overlap), billable-rates GET 200,
  projects/1/members GET 200 / POST 201 / DELETE 200,
  projects/1/managers GET 200 / POST 201 / DELETE 200,
  clients POST 201 / DELETE 200(unref) / DELETE 400(FK-guard).
  Pre-existing blocker logged: /v1/projects list 500, /v1/clients list 500/429.
  `... --grep "admin: dashboard"` → **1 passed (44s)**.
- LIVE, TEST 2 (Alice manager) ISOLATED — passed MULTIPLE times. Latest network
  log: team-dashboard recovered through ~10×429 → 200 (×2 ranges) via the in-UI
  Retry tolerance, schedules/dashboard?tab=team 200, schedules/overrides POST 201
  + DELETE 200; /financial gated out (no profitability 200), no crash.
  `... --grep "manager .Alice."` → **1 passed (1.2m)**.
- Seed integrity post-run: clients=1 (Demo Client Ltd preserved; throwaways
  deleted), P1 members=2 (Bob+Carol; Dave removed), P1 managers=1 (Alice; Erin
  removed), schedule_overrides=0 — fully net-zero.
- LIVE regression: `... specs/auth-me-throttle.spec.ts --project=chromium-live`
  → **2 passed** (INC-003 criteria; sign-in round-trip + no /me 429 storm).
- HERMETIC: `pnpm --filter @harvoost/e2e test` → **58 passed, 13 skipped, 13
  failed** (the 13 are the prod-build-vs-`next-dev` env artifact described above;
  none INC-004-attributable; no spec/mock fix required).

# Verdict
**All 6 INC-004 page-areas load + function LIVE** (every INC-004 endpoint returns
200/clean — no 400/404; FK-guard returns a clean 400, never a 500; the schedule
override POST is accepted in the spec shape, not 422). **The hermetic suite is
free of NEW failures attributable to INC-004** (the spec/mock are unchanged by
INC-004 and the reports-envelope spec passes; the 13 mocked failures are a
prod-build-vs-`next-dev` environment artifact). One pre-existing, NON-INC-004
BigInt-serialization 500 on the `/v1/users|projects|clients` LIST endpoints
blocks the `/admin/projects` + `/admin/clients` page tables and the user pickers
from rendering in the UI — recommended as a follow-up incident.
