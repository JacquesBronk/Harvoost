---
phase: 05-test
agent: e2e-tester
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Verified INC-008 (GitHub #11 — OIDC RP-initiated logout) LIVE against the
freshly-rebuilt, healthy Docker stack (chromium-live, http://localhost:3000,
real Keycloak at harvoost.localhost:8080). Authored a durable live-gated
regression spec that drives the full headline journey: sign in as Alice →
Sign Out → assert the logout response shape + the browser transiting the
Keycloak end_session_endpoint → re-login presents the Keycloak credentials form
(no silent re-auth) → authenticate as a DIFFERENT user (Bob) and confirm the app
lands as Bob. All three #11 acceptance steps PASS, twice consecutively (no
flakiness). The hermetic `@harvoost/e2e` suite still tallies 60 pass / 11 fail
(0 NEW failures vs baseline); no mock-api change was required.

**Headline answer: YES — Sign Out now ends the Keycloak SSO session and allows
switching users.** Pre-fix the next login silently re-authenticated Alice with
no prompt; post-fix the Keycloak login FORM is presented and Bob authenticates
cleanly as a different user.

# Per-step PASS/FAIL (live, chromium-live)

- **Step 1 — Logout returns + navigates to the IdP: PASS.**
  - `POST /v1/auth/logout` → `{ ok: true, logout_url: <non-null> }`. (Status code
    is **201**, not 200 — NestJS @Post default; the body shape is the real
    contract and matches the pinned `{ ok, logout_url }`. Test accepts 2xx and
    notes the discrepancy.)
  - Captured `logout_url`:
    `http://harvoost.localhost:8080/realms/harvoost/protocol/openid-connect/logout?client_id=harvoost-web&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Flogin`
    Asserted: host = `http://harvoost.localhost:8080` (realm issuer host);
    path = `/realms/harvoost/protocol/openid-connect/logout`
    (the discovered end_session_endpoint); `client_id=harvoost-web`;
    `post_logout_redirect_uri=http://localhost:3000/login`.
  - The browser actually navigated THROUGH the Keycloak end_session_endpoint
    (asserted via the main-frame navigation log) and, after the Option B logout
    confirmation, landed back on the web `/login`.
  - No INC-003/005 regression: a `/v1/auth/me` immediately after logout → **401**
    (session cookie cleared).

- **Step 2 — IdP SSO session is actually ended (the headline / former bug): PASS.**
  - Re-initiating login (`/login` → Continue with IdP) lands on the Keycloak
    **authorize → login page** and renders the **credentials form**: the
    username/email textbox AND the `#password` field are both visible.
  - This is the concrete proof of no silent re-auth: pre-fix Keycloak's SSO
    cookie was still valid and bounced straight back into the app as Alice with
    no form; post-fix the form is presented.

- **Step 3 — Switch users: PASS.**
  - From that Keycloak form, authenticated as a DIFFERENT user **Bob**
    (`bob@harvoost.local` / `dev-bob-pass`). The app landed in the shell;
    `/v1/auth/me` returned `bob@harvoost.local` (NOT alice@harvoost.local —
    explicit negative asserted). Bob's shell rendered (Sign out present, no error
    boundary). The user switch #11 demands works.

- **Step 4 — Graceful null fallback: SKIPPED (as authorized).** The
  `logout_url:null` fallback is unit-covered (backend `logout-rp-initiated.test.ts`)
  and the hermetic `auth.spec.ts` sign-out test exercises the local-`/login`
  fallback path (mock returns no `logout_url`). Not re-proven live.

# Hermetic baseline tally
`E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test` (chromium-mocked) →
**60 passed / 11 failed / 22 skipped** — IDENTICAL to the stated baseline
(60 pass / 11 fail). **ZERO new failures.** The 11 failures are pre-existing and
unrelated to INC-008 (approvals lists, the auth-callback Set-Cookie test, the
chatbot specs, two csrf specs, one throttle-bucket spec). The hermetic sign-out
test (`auth.spec.ts:203` "sign-out POSTs /v1/auth/logout, clears the cookie,
redirects to /login") and `auth.spec.ts:239` ("after logout … 401") both PASS.

# Mock-api change
**NONE.** The hermetic mock `/v1/auth/logout` handler still returns `{ ok: true }`
(no `logout_url` key). The web `requestLogout` coerces a missing/absent
`logout_url` to `null`, and `resolveLogoutNavigation(null-ish)` returns
`{ kind: 'login' }` → `router.push('/login')`. So the hermetic flow already falls
back to the local `/login` redirect without ever attempting a real-IdP
navigation. The dispatch said update the mock "ONLY if needed" — it was not
needed (the relevant hermetic sign-out test is green). Left untouched.

# Files touched
- tests/e2e/specs/inc008-rp-logout.spec.ts (new) — durable live-gated regression
  spec (`test.skip(!isLiveMode())`), serial + auth-throttle-paced (reuses the
  oidc-flow one-login-per-window discipline + the hardened Keycloak login
  helper). Captures steps 1–3.

# What downstream agents need to know
- **Option B confirmation prompt (user-visible).** Because Option B sends NO
  `id_token_hint`, Keycloak does NOT redirect silently after Sign Out — it first
  renders a logout-CONFIRMATION page ("Logging out / Do you want to log out?"
  with a **Logout** button). The browser only reaches `/login` after that button
  is clicked. The spec clicks it (a real user must too). This is the documented
  Option B tradeoff (backend HANDOFF lines 81–84), NOT a bug — but it IS a real
  extra click in the live sign-out UX worth noting for product/UX. The SSO
  session is genuinely ended only after the user confirms.
- **Logout status code is 201, not 200.** The pinned contract describes it as
  "200" but the implemented `@Post('logout')` has no `@HttpCode(200)`, so NestJS
  returns its default **201**. The JSON body shape is correct. If the OpenAPI/
  contract pins 200, either add `@HttpCode(200)` to the controller OR update the
  contract to 201 — minor, not blocking. The spec asserts 2xx + the body shape.
- **Logout response body race (test-infra note).** `handleSignOut` does a
  full-page `window.location.assign(logout_url)` the instant the logout response
  resolves, which tears down the page context — a post-hoc `response.json()`
  fails with "No resource with given identifier". The spec captures the body
  via a `page.route` interceptor (fetch → buffer body → fulfill with the real
  response incl. Set-Cookie) so the JSON is held before the redirect fires.
  Reuse this pattern for any future test that reads a response body that triggers
  an immediate full-page navigation.
- **Throttle pacing.** The auth controller is 5/60s per IP shared across all auth
  endpoints (incl. logout). This single test does TWO full logins + a logout, so
  it waits one full window mid-test (after the logout, before the Bob re-login)
  and the runner must leave a window between repeat runs of login-bearing specs.
  Wall-clock per run is ~1.1 min (Keycloak redirect chain + the mid-test window).

# Open questions / unknowns
- None blocking. Two minor product/contract notes flagged above (the 201-vs-200
  status and the Option B confirmation click) for the orchestrator's decision
  log — both are working-as-implemented, not regressions.

# Verification evidence
- `pnpm exec tsc --noEmit -p tsconfig.json` → 0 errors in inc008-rp-logout.spec.ts
  (only pre-existing chatbot.spec.ts `findLast` lib-target errors remain).
- Hermetic: `E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test` (chromium-mocked)
  → 60 passed / 11 failed / 22 skipped (== baseline; 0 new failures).
- Live: `E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test
  inc008-rp-logout.spec.ts --project=chromium-live` → **1 passed** (~1.1 min),
  run TWICE consecutively (both pass) → no flakiness observed.
- Stack confirmed healthy pre-run: harvoost-web/api/keycloak/postgres all
  `(healthy)`; Keycloak discovery doc advertised
  `end_session_endpoint=http://harvoost.localhost:8080/realms/harvoost/protocol/openid-connect/logout`;
  realm.json `harvoost-web` allowlists `http://localhost:3000/login` as a
  `post.logout.redirect.uris` value.
