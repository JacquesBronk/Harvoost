# Harvoost end-to-end tests

Browser-based Playwright tests covering the eleven primary user journeys in REQUIREMENTS.md plus the high-value cross-cutting tests (idempotency, cost-stripping, CSRF, throttle, security headers, OIDC). Electron tray smoke is opt-in via `E2E_TRAY=1`.

## Two run modes

Per ADR-0001 (OIDC provider-agnostic; Keycloak in dev, Entra in prod), the suite runs in two modes:

| Mode       | Trigger          | Backend          | IdP                     | Speed | Use            |
|------------|------------------|------------------|-------------------------|-------|----------------|
| Hermetic   | (default)        | In-process mock  | None (mock-api fakes OIDC callback) | Fast  | CI default     |
| Live-stack | `E2E_LIVE=1`     | Real apps/api    | Real Keycloak (docker)  | Slow  | Smoke / nightly|

**Hermetic mode** is the default CI lane. Every spec uses `page.route()` to intercept calls to the API origin and return canned RBAC-aware fixtures drawn from `RBAC_TEST_FIXTURE`. The mock-api speaks real session-cookie semantics (Set-Cookie on OIDC callback, clearCookie on logout) and mirrors backend CSRF + throttle + security-header behaviours. The `signInAs()` helper short-circuits the OIDC handshake by hitting the mock-api's own `/v1/auth/oidc/callback` shim.

**Live-stack mode** drives the real backend against a real Keycloak. The `signInAs()` helper performs the full handshake: `/login` → [IdP sign-in button] → Keycloak login form (username + dev password) → `/auth/callback?code=...` → backend validates the id_token via `jose` against the discovered JWKS → session cookie → `/timesheets`. The button label is IdP-agnostic (ADR-0001): it reads "Continue with {display_name}" from `GET /v1/auth/idp-info`, falling back to "Continue with your identity provider". Most hermetic specs skip themselves in live mode via `test.skip(isLiveMode(), ...)` because their assertions inspect in-process mock-state; the load-bearing live coverage lives in `specs/oidc-flow.spec.ts`.

## Quick start (hermetic — default)

```
pnpm install
pnpm e2e:install            # downloads Chromium browser binaries
pnpm e2e                    # runs the "mocked" project
```

The mocked project boots `apps/web` via `next dev` (configured in `playwright.config.ts` → `webServer`) and intercepts every call to the API origin with `fixtures/mock-api.ts`. Recommended for CI.

## Live-stack mode

Prerequisites:

```
# 1. Start postgres + keycloak (devops lane added keycloak per ADR-0001).
docker compose up -d postgres keycloak

# 2. Wait for keycloak healthcheck; then migrate + seed Harvoost DB.
pnpm db:migrate && pnpm db:seed

# 3. Boot the API + web with the live env (apps/api reads
#    OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost).
pnpm dev

# 4. Run live e2e.
E2E_LIVE=1 pnpm --filter @harvoost/e2e e2e
```

The live lane exercises the real OIDC handshake plus any mode-agnostic spec (e.g., `security-headers.spec.ts`). Hermetic-bound specs skip cleanly via `test.skip(isLiveMode(), ...)`. The Keycloak realm is committed at `infra/keycloak/harvoost-realm.json` and seeds the four canonical fixture users (Alice / Bob / Carol / Dave) per devops' realm import.

## Keycloak dev credentials

| Fixture key | Email                       | Password           | Harvoost role (server-side) |
|-------------|-----------------------------|--------------------|-----------------------------|
| alice       | alice@harvoost.local        | `dev-alice-pass`   | manager                     |
| bob         | bob@harvoost.local          | `dev-bob-pass`     | employee                    |
| carol       | carol@harvoost.local        | `dev-carol-pass`   | employee                    |
| dave        | dave@harvoost.local         | `dev-dave-pass`    | employee                    |
| admin       | admin@harvoost.local        | `dev-admin-pass`   | admin                       |
| finmgr      | finmgr@harvoost.local       | `dev-finmgr-pass`  | finmgr                      |
| erin        | erin@harvoost.local         | `dev-erin-pass`    | manager                     |
| frank       | frank@harvoost.local        | `dev-frank-pass`   | manager                     |
| grace       | grace@harvoost.local        | `dev-grace-pass`   | employee                    |

Passwords are dev-only. Roles are owned by Harvoost (`user_roles` table + `admin_email_allowlist`) — **NOT** propagated as Keycloak realm-role claims, per ADR-0001 § 5. See `infra/keycloak/README.md` for realm management notes.

## Coverage map

| Spec file                           | Journey                                                 | Mode      |
|-------------------------------------|---------------------------------------------------------|-----------|
| `specs/auth.spec.ts`                | 1 + 1b. OIDC sign-in + sign-out                         | both      |
| `specs/oidc-flow.spec.ts`           | OIDC: real Keycloak handshake + sub stability           | **live**  |
| `specs/clock-in.spec.ts`            | 2 + 3. Clock-in + submit week                           | hermetic  |
| `specs/manager-dashboard.spec.ts`   | 4. Manager dashboard RBAC scope                         | hermetic  |
| `specs/approvals.spec.ts`           | 5 + 6. Stage-1 + stage-2 approvals                      | hermetic  |
| `specs/chatbot.spec.ts`             | 7. Chatbot RBAC + prompt injection + CSRF pairing       | hermetic  |
| `specs/leave.spec.ts`               | 8 + 9 + 9b. Book + approve leave + RBAC role gates      | hermetic  |
| `specs/mood.spec.ts`                | 10. Mood aggregate k≥5 anonymity                        | hermetic  |
| `specs/idempotency.spec.ts`         | 11. Idempotency over network retries                    | hermetic  |
| `specs/cost-stripping.spec.ts`      | 12. Cost columns stripped per role                      | hermetic  |
| `specs/excel-export.spec.ts`        | 13. Excel export contract (skip in mocked)              | hermetic  |
| `specs/tray-app.spec.ts`            | 14. Electron tray smoke (opt-in)                        | opt-in    |
| `specs/exceptions.spec.ts`          | 14b. Exception self-resolve only (Finding 2)            | hermetic  |
| `specs/csrf.spec.ts`                | 15. CSRF middleware (Finding 8)                         | hermetic  |
| `specs/throttle.spec.ts`            | 16 + 17. Auth + chatbot throttle decorators (Finding 4) | hermetic  |
| `specs/security-headers.spec.ts`    | 18. helmet HSTS / nosniff / Referrer-Policy (Finding 10)| both      |

Specs marked **hermetic** carry `test.skip(isLiveMode(), 'hermetic-only — ...')` at module scope because their assertions inspect mock-state (counters, seeded entries, exact error bodies) that has no live counterpart. The auth flow is exercised live by `oidc-flow.spec.ts`; the security headers are exercised live by `security-headers.spec.ts` (both modes inject the same headers).

## Environment variables

| Variable                    | Default                  | Purpose                                     |
|-----------------------------|--------------------------|---------------------------------------------|
| `E2E_LIVE`                  | unset                    | Run against the real backend + Keycloak     |
| `E2E_TRAY`                  | unset                    | Enable Electron tray smoke (needs display)  |
| `E2E_WEB_BASE_URL`          | `http://localhost:3000`  | Override the web origin                     |
| `E2E_API_BASE_URL`          | `http://localhost:3001`  | Override the API origin                     |
| `E2E_KEYCLOAK_URL`          | `http://localhost:8080`  | Override the Keycloak origin (live only)    |
| `E2E_KEYCLOAK_REALM`        | `harvoost`               | Override the realm name (live only)         |
| `E2E_SKIP_WEB_SERVER`       | unset                    | Skip the auto-boot of `pnpm --filter @harvoost/web dev` |

## Selector strategy

`getByRole` first, then `getByLabel`, then `getByText`. Never CSS classes or DOM-structural selectors. No `data-testid` was added to production code for this suite — every assertion targets accessible semantics already exposed by `@harvoost/ui` and the page-level components.

Keycloak's stock login template has `<label for="username">` + `<label for="password">` so `getByLabel(/username|email/i)` and `getByLabel(/password/i)` both work in live mode without modifications to Keycloak.

## Known limitations

- The mocked project cannot validate XLSX byte output (`specs/excel-export.spec.ts` is `.skip()` in mocked mode). The unit test `packages/shared/src/excel/__tests__/HarvestExportSchema.test.ts` covers the column schema; the live-stack lane should unskip this spec once the XLSX writer ships.
- Tray-app smoke requires Electron + a display environment and is gated behind `E2E_TRAY=1`.
- The first live run after a clean docker volume will be slower because Keycloak loads its realm import on first boot (~10-15s). Subsequent runs are ~3s.
- Live mode does NOT exercise the Entra ID production IdP — only Keycloak. The same OIDC code path runs against both per ADR-0001, so passing against Keycloak is strong (but not absolute) evidence that production Entra will also work.
