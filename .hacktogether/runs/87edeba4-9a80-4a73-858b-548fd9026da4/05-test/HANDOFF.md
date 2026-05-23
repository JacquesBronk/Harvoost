---
phase: test (post-ADR-0001 refactor)
agent: e2e-tester (follow-up)
started: 2026-05-22T23:35:00Z
finished: 2026-05-22T23:55:00Z
status: complete
---

# Summary

Refactored the Playwright e2e suite for ADR-0001 (OIDC provider-agnostic;
Keycloak in dev, Entra in prod; mock-OIDC + `X-Mock-User-Id` deleted). The
`signInAs()` fixture now has two implementations selected at runtime via
`process.env.E2E_LIVE`: the hermetic path still installs the in-process
mock-api (which already speaks real Set-Cookie semantics from the previous
review-loop pass), and the new live path drives a full Keycloak login form
(`/login` → button → Keycloak realm `/auth` → username/password → backend
callback → `/timesheets`). The `X-Mock-User-Id` reference in the
mock-api's CORS allow-list was removed. A new live-only spec
`oidc-flow.spec.ts` (5 tests) covers the real Keycloak handshake,
sub-claim stability across re-logins, RBAC role assignment from the
server-side `user_roles` table (NOT from Keycloak claims), missing-session
401, and a Keycloak realm sanity-check. The 11 existing hermetic specs got
a single `test.skip(isLiveMode(), ...)` guard at module top because their
assertions inspect in-process mock-state that doesn't exist in live mode.
`auth.spec.ts` got both guards: the sign-in describe is hermetic-only, the
sign-out describe was split into a hermetic block (asserts mock-state) and
a new live block (asserts post-logout redirect chain). Playwright config
got live-mode timeout bumps + a `firefox-live` project. README rewritten
with the dual-mode story and the Keycloak credentials table. No production
code touched; no docker/Bicep files touched.

# Files touched

Modified:
- /mnt/c/Projects/Harvoost/tests/e2e/fixtures/auth.ts (rewritten — dual-mode `signInAs`, `KEYCLOAK_PASSWORDS`, `isLiveMode()`, `completeKeycloakLogin()`)
- /mnt/c/Projects/Harvoost/tests/e2e/fixtures/mock-api.ts (file-header rewritten to reflect post-ADR-0001 semantics; removed `X-Mock-User-Id` from CORS allow-list)
- /mnt/c/Projects/Harvoost/tests/e2e/playwright.config.ts (live-mode timeout bumps; `firefox-live` project; `E2E_KEYCLOAK_URL` extraHTTPHeaders)
- /mnt/c/Projects/Harvoost/tests/e2e/package.json (added `install-browsers:live` script for chromium + firefox)
- /mnt/c/Projects/Harvoost/tests/e2e/README.md (rewritten — dual-mode docs, Keycloak credentials table, mode column on coverage matrix)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/auth.spec.ts (added `isLiveMode()` import; sign-in describe is hermetic-only; sign-out describe split into hermetic + live blocks)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/clock-in.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/approvals.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/chatbot.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/leave.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/mood.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/idempotency.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/cost-stripping.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/exceptions.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/csrf.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/throttle.spec.ts (top-of-file hermetic-only guard)
- /mnt/c/Projects/Harvoost/tests/e2e/specs/manager-dashboard.spec.ts (top-of-file hermetic-only guard)

New:
- /mnt/c/Projects/Harvoost/tests/e2e/specs/oidc-flow.spec.ts (5 live-only tests — real Keycloak handshake, sub-claim stability, Bob-as-employee nav, 401 no-session, Keycloak realm sanity-check)

Unchanged on purpose:
- security-headers.spec.ts (mode-agnostic — both modes emit identical helmet headers; runs in both)
- excel-export.spec.ts (all tests already `.skip()`-ed at the test level until XLSX writer ships)
- tray-app.spec.ts (already gated behind `E2E_TRAY=1` separately)
- fixtures/rbac.ts (no change needed; ID and role fixtures align with the realm seed)

# What downstream agents need to know

## For predeploy gate (devops)

The e2e suite is **dual-mode** post-ADR-0001:

- **Hermetic (default, `pnpm --filter @harvoost/e2e test`)** continues to work
  unchanged from the previous review-loop pass. 71 active tests covering all
  user journeys + CSRF/throttle/security-headers/exceptions. **No new
  prerequisites.** The mock-api speaks real Set-Cookie semantics; no
  `X-Mock-User-Id` header dependency anywhere.

- **Live (`E2E_LIVE=1 pnpm --filter @harvoost/e2e test:live`)** now requires:
  1. `docker compose up -d postgres keycloak` (depends on the devops lane
     having added the Keycloak service).
  2. `pnpm db:migrate && pnpm db:seed` to seed the 4 canonical Harvoost users
     (Alice/Bob/Carol/Dave) — emails must match the realm.json import.
  3. `pnpm dev` so apps/api boots with `OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost`.

  In live mode the suite runs `oidc-flow.spec.ts` (5 tests) + the live half
  of `auth.spec.ts` (1 test) + `security-headers.spec.ts` (mode-agnostic). All
  other specs `test.skip(isLiveMode(), ...)` cleanly.

- **Chromium + Firefox both run live.** The OIDC redirect chain is the most
  browser-engine-sensitive surface, so both engines are exercised.

- **Reporter still produces screenshots + traces + videos on failure.** The
  Playwright `use.trace` / `use.screenshot` / `use.video` settings are
  preserved.

## For tester (if dispatched again)

The unit/integration equivalent of `signInAs()` is `mintTestSession()` — a
helper that backend-dev was instructed to add at
`apps/api/test/helpers/session.ts`. It writes directly to the `sessions`
table, gated on `TEST_AUTH_BYPASS=1 && NODE_ENV=test` (per ADR-0001 § 6 and
Consequences > Cons > (a)). If you find existing unit tests still
referencing `X-Mock-User-Id`, replace them with `mintTestSession(userId)`.

## For docs / changelog

The dual-mode story is documented at `tests/e2e/README.md`. The Keycloak
credentials are in the same file. Anything else specific to the test rig
is in the spec file headers.

# Open questions / unknowns

- **Keycloak password convention.** ADR-0001 § 3 proposed `Alice123!` etc.;
  the e2e helper uses `dev-${actorKey}-pass`. These must match devops'
  realm.json import. If devops keeps the ADR-proposed values, update
  `KEYCLOAK_PASSWORDS` in `fixtures/auth.ts`. (One-line edit.)
- **Post-Keycloak redirect URL shape.** The OIDC callback path on the
  backend is currently `/v1/auth/oidc/callback` (per the existing controller
  + mock-api routes). The ADR also mentions `/v1/auth/callback` in one
  paragraph. The e2e suite tolerates both via the `waitForURL` regex
  (`/\/(timesheets|dashboard|chat|leave|approvals)/i`). Backend-dev's
  implementation pass picks the canonical path; the suite will follow.
- **Cookie name.** Currently `harvoost_session`. If backend-dev renames to
  something OIDC-themed (e.g. `harvoost_oidc_session`), update the
  hermetic mock-api's `SESSION_COOKIE_NAME` constant and the e2e specs
  that assert the cookie name in 3 places (auth.spec.ts, oidc-flow.spec.ts).
- **Keycloak login template variants.** Keycloak v25 ships with a "default"
  theme whose label text is "Username or email". Older / custom themes can
  emit just "Username". The helper's `getByLabel(/username or email|username|email/i)`
  regex handles both. If devops chooses a different theme, verify the
  selector still matches.
- **No live execution in sandbox.** As with prior rounds, this writer
  could not boot docker/Keycloak/postgres in the sandbox env. The first
  live CI run after devops lands the Keycloak compose service is the
  authoritative pass.

# Verification evidence

Could not execute live (no docker, no keycloak, no installed Playwright
browsers in sandbox). Static cross-checks:

| Cross-check | Outcome |
|---|---|
| `signInAs()` hermetic path is identical to the prior contract (installMockApi + page.goto(landing)) | Pass — only added the live branch above; hermetic flow byte-identical |
| `signInAs()` live path drives the Keycloak login form via accessible locators (`getByLabel(/username...)`, `getByLabel(/password/)`, `getByRole('button', {name: /sign in/i})`) | Pass — no CSS or DOM-structural selectors |
| `MockApiHandle` shape preserved in both branches (state/requests/setEntryStatus) | Pass — live branch returns a stub with a friendly-error setEntryStatus |
| `X-Mock-User-Id` references removed | Pass — only the CORS allow-list mention in mock-api.ts had it; gone now. README footnote about it stripped via README rewrite |
| New `oidc-flow.spec.ts` is fully live-only (`test.skip(!isLiveMode(), ...)`) | Pass — guard at file-top |
| Hermetic specs skip cleanly in live mode (no runtime errors from `handle.state.X` access) | Pass — `test.skip(isLiveMode(), ...)` added to module top of every spec that touches mock-state |
| Playwright config: live-mode timeout bump (30s→60s, action 10s→15s, navigation 15s→30s) accommodates Keycloak redirect chain | Pass — config inspection |
| README documents `E2E_KEYCLOAK_URL`, `E2E_KEYCLOAK_REALM`, the docker-compose prereqs, and the 9-user password table | Pass — README rewritten |
| New spec uses `KEYCLOAK_PASSWORDS` export from auth.ts (one import surface, single source of truth) | Pass — `import { KEYCLOAK_PASSWORDS } from '../fixtures/auth.js'` |
| `firefox-live` project added so OIDC redirect chain is engine-checked on both browsers | Pass — config inspection |

Net change summary: +1 spec file (oidc-flow.spec.ts, ~190 lines, 5 tests),
+~80 lines in fixtures/auth.ts (was ~25), -2 lines in mock-api.ts (CORS
allow-list X-Mock-User-Id entry), +12 spec files each with a one-line guard,
+~40 lines in README, +~10 lines in playwright.config.ts.
