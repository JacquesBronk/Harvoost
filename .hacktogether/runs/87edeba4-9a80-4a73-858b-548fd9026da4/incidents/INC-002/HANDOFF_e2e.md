---
phase: 05-test
agent: e2e-tester
started: 2026-05-23T11:00:00Z
finished: 2026-05-23T11:18:00Z
status: verified-product-fix-confirmed
verified_pass_2: 2026-05-23
---

# Summary
Live-verified the INC-002 hotfix end-to-end against the running dev docker-compose
stack (web :3000, api :3001, Keycloak `http://harvoost.localhost:8080`). Fixed the two
test-FIXTURE bugs called out in the dispatch (strict-mode password locator; wrong
`keycloakBase` issuer host), then re-ran the live OIDC spec. In doing so I uncovered
three further TEST-HARNESS issues (about:blank fetch, Node `*.localhost` DNS, and the
backend auth rate-limiter colliding with a login-heavy suite) which I also fixed inside
`tests/e2e/` only — and ONE genuine PRODUCT bug that crashes the `/timesheets` shell for
every OIDC-authenticated user. The load-bearing acceptance criterion (Alice signs in via
real Keycloak and lands on `/timesheets` with a real session) is CONFIRMED at the
redirect/callback/session level; the product crash is a separate post-login render defect
that does not affect the INC-002 callback round-trip.

# Files touched (tests/e2e ONLY — no product code modified)
- `tests/e2e/fixtures/auth.ts` (modified) — hardened the live Keycloak login locators.
- `tests/e2e/specs/oidc-flow.spec.ts` (modified) — fixed `keycloakBase` issuer host; fixed
  Node-side discovery fetch; fixed about:blank fetch; added auth-throttle pacing; marked
  the two product-bug-blocked tests `test.fixme` with a precise root-cause note.

## Fixture fix #1 — strict-mode password locator (`fixtures/auth.ts`)
Verified against the live Keycloak 25 PatternFly DOM (probed the running stack):
`getByLabel(/password/i)` matched **2** elements — the `<input id="password" type="password">`
AND a `<button aria-label="Show password" data-password-toggle type="button">` toggle —
tripping strict mode. Changed:
- password: `page.getByLabel(/password/i)` → `page.locator('#password')` (toggle is a button,
  not an input; `#password` is the stable anchor). Live counts: old=2, new=1.
- username: `page.getByLabel(/username or email|username|email/i)` →
  `page.getByRole('textbox', { name: /email|username/i })` (role-based, unambiguous; the
  realm uses `registrationEmailAsUsername` so the field's label renders as "Email"). Count=1.
- submit button locator was already unambiguous (count=1), left as-is.

## Fixture fix #2 — wrong `keycloakBase` issuer host (`specs/oidc-flow.spec.ts:32`)
The dev stack pins Keycloak's frontend hostname via `--hostname=http://harvoost.localhost:8080`,
so the discovery doc's `issuer` (and tokens' `iss`) is `http://harvoost.localhost:8080/realms/harvoost`,
NOT `http://localhost:8080/...`. Changed the fallback default
`http://localhost:8080` → `http://harvoost.localhost:8080`. This fixes BOTH uses: the
issuer assertion in the realm-export test AND the `sawKeycloakAuth` redirect-chain
`.includes(keycloakBase)` check in the Alice test (the browser is redirected to the
`harvoost.localhost` authorize endpoint, so the old value never matched there either).

## Additional TEST-HARNESS fixes (surfaced on first-ever live execution; all in tests/e2e)
- **Node cannot resolve `*.localhost`** — Playwright's `request` fixture (Node fetch) threw
  `getaddrinfo ENOTFOUND harvoost.localhost` on the discovery-doc GET (Chromium maps
  `*.localhost`→loopback, Node does not). Fixed the realm-export test to fetch via
  `http://127.0.0.1:8080` with a `Host: harvoost.localhost:8080` header; Keycloak still
  advertises the correct frontend issuer, so the assertion still checks the real value.
- **about:blank fetch** — the "no session → 401" test did `page.evaluate(fetch(...))` from a
  fresh page still on `about:blank` → `TypeError: Failed to fetch` (no document origin).
  Fixed by `await page.goto('/login')` before the fetch.
- **Auth rate-limiter (5 req / 60s per IP) vs a login-heavy suite** — the entire backend
  `AuthController` is `@Throttle({ auth: { ttl: 60_000, limit: 5 } })`, shared across
  `idp-info`, `oidc/login`, `oidc/callback` AND `/v1/auth/me`. One full live login spends
  ~4 of the 5 slots, so back-to-back logins make the second handshake's `oidc/callback`
  POST return 429 → the callback fails → the app bounces to `/login` (this is CORRECT
  product behaviour, the limiter doing its job — not a callback bug). Fixed in-harness:
  the describe runs `mode: 'serial'` and a `beforeEach`/`afterEach` paces one login per
  60s throttle window (wait anchored on the limiter's real fixed-window TTL, no endpoint
  polling that would re-pollute the budget). `fetchMe` does a single (non-polling) call.

# Final live-run result (the exact instructed command)
```
cd /mnt/c/Projects/Harvoost/tests/e2e
E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test specs/oidc-flow.spec.ts --project=chromium-live --reporter=list
```
Result on a clean throttle window: **3 passed, 2 skipped, 0 failed** (≈2.1m wall, the
time is dominated by the deliberate one-login-per-60s throttle pacing).

- PASS — `Alice signs in via Keycloak and the session is real-OIDC-validated` (the
  load-bearing acceptance criterion #3). Asserts: URL is `/timesheets`; `harvoost_session`
  cookie is set, HttpOnly, SameSite=Lax, len>20; `GET /v1/auth/me` → 200 with
  `alice@harvoost.local` + role `manager`; the browser was redirected to the real Keycloak
  `/protocol/openid-connect/auth` endpoint. Verified redirect trail:
  `/login → harvoost.localhost:8080/.../auth?...code_challenge... → /auth/callback?code=... → /timesheets`
  with `oidc/callback → 201` and a 43-char opaque session cookie.
- PASS — `directly hitting a Keycloak-validated route without a session yields 401`.
- PASS — `Keycloak realm export matches the fixture user set` (issuer ==
  `http://harvoost.localhost:8080/realms/harvoost`).
- SKIPPED (`test.fixme`, product-blocked) — `sub-claim stability ... across two logins`.
- SKIPPED (`test.fixme`, product-blocked) — `Bob (employee role) lands without manager-only nav`.

NOTE: only `--project=chromium-live` was run. `firefox-live` was intentionally NOT run
(Firefox is not installed in this environment; launching it would be a tooling failure,
not a product/test failure).

# What downstream agents need to know
## PRODUCT BUG — `/timesheets` app shell crashes for OIDC-authenticated users (NOT a callback bug; do NOT fix in tests/e2e)
- **Symptom**: after a successful real OIDC login, the URL is `/timesheets`, the session
  cookie is set, and `/v1/auth/me` returns 200 — but the rendered page is the error
  boundary "Something went wrong — `Cannot read properties of undefined (reading 'trim')`",
  with only a "Try again" button. No sidebar nav, no sign-out button render.
- **Root cause (two product facets)**:
  1. `apps/api/src/auth/auth.controller.ts:328-331` — `GET /v1/auth/me` returns
     `{ id, email, roles }` only; it OMITS `display_name`. (Live body for Alice:
     `{"id":"3","email":"alice@harvoost.local","roles":["manager"]}`.)
  2. `apps/web/src/components/AppShell.tsx:169` renders `<Avatar name={user.display_name} />`
     with `display_name` undefined → `packages/ui/src/components/Avatar.tsx:10`
     `name.trim()` throws → whole shell falls into the React error boundary.
     (The web `CurrentUser` type at `apps/web/src/lib/auth.ts:11` declares
     `display_name: string` as NON-optional, which is why nothing guards it.)
- **Why the Alice test still passes**: it asserts URL + cookie + `/v1/auth/me` only and does
  not touch the rendered shell, so the redirect/callback/session leg (the INC-002 subject)
  is provably correct even though the page visually crashes.
- **Why two tests are `test.fixme`**: `sub-claim stability` needs the Sign-out button and
  `Bob nav` needs the sidebar links — both live in the crashed shell, so they cannot pass
  until the product bug is fixed. Their bodies are correct and verified to drive the right
  flow up to the crash; flip `test.fixme` → `test` once fixed.
- **Suggested product fix lane**: API — include `display_name` in `/v1/auth/me`
  (it already maintains `users.display_name`; the OIDC upsert sets it), AND/OR UI — make
  `Avatar`/`AppShell` tolerate a missing name. Either alone unblocks the two `fixme` tests;
  doing both is belt-and-braces. NOTE: the api `@Get('me')` return type literal must also
  be widened if `display_name` is added.

## INC-002 hotfix itself — VERIFIED GOOD at the level it targets
The provider-agnostic OIDC redirect/callback round-trip works end-to-end against real
Keycloak with the corrected `/auth/callback` redirect path, PKCE, opaque_state_id, and a
real HttpOnly session cookie. The earlier Keycloak "Invalid redirect_uri" is gone.

## Throttle interaction worth recording
`GET /v1/auth/me` sharing the 5/60s `auth` throttle budget with the login endpoints makes
ANY automated multi-login flow brittle and could surprise real SPAs that poll `/v1/auth/me`.
Not in scope for INC-002, but flagging for the orchestrator's decision log.

# Open questions / unknowns
- The `/timesheets` shell crash is reproducible on every OIDC login in this environment; I
  could not tell from the live run whether the same crash predates INC-002 (the live spec
  had never been executed before this run). It is independent of the callback fix.

# Verification evidence
- Live Keycloak DOM probe → `getByLabel(/password/i)`=2 (input + "Show password" toggle),
  `locator('#password')`=1, `getByRole('textbox',{name:/email|username/i})`=1.
- `curl …/.well-known/openid-configuration` → `issuer = http://harvoost.localhost:8080/realms/harvoost` (confirms fixture-fix #2).
- Node `dns.lookup('harvoost.localhost')` → ENOTFOUND; `curl -H 'Host: harvoost.localhost:8080' http://127.0.0.1:8080/.../openid-configuration` → correct issuer (confirms Node-DNS harness fix).
- Live redirect trail (diagnostic spec): `/login → harvoost.localhost:8080/.../auth?...code_challenge... → /auth/callback?code=... → /timesheets`; `oidc/callback`=201; `harvoost_session` HttpOnly/Lax, len=43; `/v1/auth/me` (fresh window) → 200 `{"id":"3","email":"alice@harvoost.local","roles":["manager"]}`.
- Captured `pageerror`/console on `/timesheets`: `TypeError: Cannot read properties of undefined (reading 'trim')` → error boundary "Something went wrong" (confirms the product bug).
- Final: `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test specs/oidc-flow.spec.ts --project=chromium-live --reporter=list` → **3 passed, 2 skipped (fixme), 0 failed**.
- `npx tsc --noEmit` → no errors in `oidc-flow.spec.ts` / `auth.ts` (pre-existing `chatbot.spec.ts findLast`/es2023 errors are unrelated and untouched).

---

# FINAL LIVE VERIFICATION — post product-fix (2026-05-23, e2e-tester pass 2)

## Context
The product bug from pass 1 (post-login `/timesheets` shell crashed into the React error
boundary with `Cannot read properties of undefined (reading 'trim')`) has been FIXED and
the stack REBUILT + HEALTHY. Verified live before testing:
- `curl http://localhost:3001/v1/auth/idp-info` → `{"display_name":"Keycloak","issuer":"http://harvoost.localhost:8080/realms/harvoost"}`.
- web `/login` → 200, api `/v1/health` → 200.
- Product fix confirmed in code (read-only): `apps/web/src/components/AppShell.tsx:105`
  falls back to `user.email` when `display_name` is empty; `packages/ui/src/components/Avatar.tsx`
  (`initialsOf` + `label`) now guards with `(name ?? '').trim()` — null/empty-safe.

## Test edits (tests/e2e ONLY — no product code touched)
- `tests/e2e/specs/oidc-flow.spec.ts` — restored the TWO `test.fixme` tests to normal
  `test(...)`:
  1. `sub-claim stability: same Alice keeps the same user_id across two logins`
  2. `Bob (employee role) lands without manager-only nav`
  Each now FIRST asserts the rendered shell exists before its own concern, so a regression
  of the crash fails loudly instead of silently passing a negative assertion against an
  empty error-boundary DOM:
  - Positive shell markers: `getByRole('link', { name: 'Timesheets', exact: true })` visible
    (the always-rendered sidebar nav link; `exact:true` disambiguates it from the empty-state
    body link "Start one from timesheets", both `href=/timesheets`) AND
    `getByRole('button', { name: /sign out/i })` visible.
  - Explicit anti-crash guard: `getByText(/something went wrong/i)` toHaveCount(0).
  - `sub-claim stability` additionally re-asserts the Sign out button is visible after the
    SECOND login, proving the fix holds across repeat handshakes.
- Viewport note: `chromium-live` uses `devices['Desktop Chrome']` (1280×720), above the
  Tailwind `lg` (1024px) breakpoint, so the `lg:block` sidebar footer (avatar, display name,
  Sign out button) renders visibly — the locators target genuinely-visible DOM.
- NO remaining `test.fixme` in the file (only the expected file-level
  `test.skip(!isLiveMode(), ...)` live-only gate).

## One in-pass harness fix
First re-run failed test #4 with a strict-mode violation: `getByRole('link', { name: 'Timesheets' })`
matched 2 elements — the sidebar nav `<a href="/timesheets" aria-current="page">Timesheets</a>`
AND a page empty-state link `<a href="/timesheets">Start one from timesheets</a>`. This was
itself proof the shell rendered (the error boundary produces neither). Fixed by adding
`exact: true`. Classification: TEST-HARNESS (locator), fixed in tests/e2e only. NOT a product bug.

(A second interim re-run hit a 429 on the very first test's `/v1/auth/me` — residual auth-throttle
budget from the prior run had not cleared (the limiter is a 5-req/60s fixed window per IP; the
in-process pacing clock resets to "run immediately" at each process start and has no cross-process
memory). Resolved by waiting one full >60s throttle window before the clean re-run. Documented
behaviour, not a product bug.)

## Final live-run result (exact instructed command, clean throttle window)
```
cd /mnt/c/Projects/Harvoost/tests/e2e
E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test specs/oidc-flow.spec.ts --project=chromium-live --reporter=list
```
**5 passed, 0 failed, 0 skipped** (5.2m wall — dominated by the deliberate one-login-per-60s
throttle pacing). NO `fixme` skips remain.

- PASS — `Alice signs in via Keycloak and the session is real-OIDC-validated` (criterion #3:
  URL `/timesheets`, HttpOnly `harvoost_session` cookie SameSite=Lax len>20, `/v1/auth/me` → 200
  `alice@harvoost.local` role `manager`, browser redirected to real Keycloak `/auth`).
- PASS — `directly hitting a Keycloak-validated route without a session yields 401`.
- PASS — `Keycloak realm export matches the fixture user set` (issuer
  `http://harvoost.localhost:8080/realms/harvoost`).
- PASS — `sub-claim stability: same Alice keeps the same user_id across two logins`
  (previously `fixme`): after login 1 the shell RENDERED (Timesheets nav link + Sign out
  button visible, no "something went wrong"), Sign out clicked → back to `/login`; after
  login 2 the shell RENDERED again; `user_id` stable across both logins.
- PASS — `Bob (employee role) lands without manager-only nav` (previously `fixme`):
  Bob's shell RENDERED (Timesheets nav link visible, no error boundary), and the
  Approvals / Team manager-only links are correctly ABSENT for the employee role.

NOTE: only `--project=chromium-live` was run; `firefox-live` intentionally NOT run (Firefox
not installed — per dispatch).

## POST-LOGIN SHELL RENDER — CONFIRMED
After Alice (and Bob) log in via real Keycloak, the `/timesheets` app shell RENDERS FULLY:
sidebar nav (Timesheets link) and the Sign out control are visible, and the prior
"Something went wrong" error boundary / `Cannot read properties of undefined (reading 'trim')`
crash is GONE (explicitly asserted absent). The INC-002 product bug is verified FIXED end-to-end.

SHELL RENDER + FULL ROUND-TRIP: CONFIRMED (5 passed, 0 skipped)
