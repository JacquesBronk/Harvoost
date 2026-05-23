---
phase: incidents/INC-002
agent: backend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Implemented the BACKEND lane of INC-002 (everything outside `apps/web`). Fixed the OIDC
callback-path mismatch (B2) by repointing `OIDC_REDIRECT_URI_WEB` to the page the web app
actually serves (`/auth/callback`) and adding that URI to the Keycloak realm allowlist. Added a
new PUBLIC `GET /v1/auth/idp-info` endpoint that returns provider-agnostic login-page metadata
(`{ display_name, issuer }`) sourced from a new `OIDC_DISPLAY_NAME` env var, with graceful
fallbacks. Baked `NEXT_PUBLIC_WEB_BASE_URL` as a Docker build-arg to close the latent
INC-001-class footgun. Confirmed (no code change needed) that the `opaque_state_id` round-trip is
already sound: `/oidc/login` persists state/nonce/code_verifier in `auth_pending` and returns the
row's UUID `id` as `opaque_state_id`; `/oidc/callback` validates `opaque_state_id` against that row
and checks `state` matches. The canonical contract holds end-to-end on the backend side.

# Files touched
- `apps/api/src/config/env.ts` (modified) — `OIDC_REDIRECT_URI_WEB` default changed `/v1/auth/callback` → `/auth/callback`; added optional `OIDC_DISPLAY_NAME` env var.
- `.env` (modified) — same redirect_uri change; added `OIDC_DISPLAY_NAME=Keycloak` (dev runtime value).
- `.env.example` (modified) — same redirect_uri change; added `OIDC_DISPLAY_NAME=Microsoft Entra ID` (prod-parity placeholder per task).
- `infra/keycloak/realm.json` (modified) — added `http://localhost:3000/auth/callback` to `harvoost-web.redirectUris` (kept both existing `/v1/auth/callback` entries; no other consumer broken).
- `apps/api/src/auth/auth.controller.ts` (modified) — added PUBLIC `GET /v1/auth/idp-info` handler + `deriveDisplayNameFromIssuer()` helper + a `Logger`; imported `Logger` from `@nestjs/common`.
- `apps/api/test/unit/idp-info.test.ts` (new) — 5 unit tests: env-var path, whitespace-trim fallthrough, discovery-fallback path, derived-name path, last-resort literal.
- `docker/Dockerfile.web` (modified) — added `ARG NEXT_PUBLIC_WEB_BASE_URL=http://localhost:3000` + matching `ENV` in the build stage (mirrors the `NEXT_PUBLIC_API_BASE_URL` block).
- `docker-compose.yml` (modified) — `web.build.args` now passes `NEXT_PUBLIC_WEB_BASE_URL: http://localhost:3000`.
- `.hacktogether/runs/.../03-api-design/openapi.yaml` (modified) — documented `GET /v1/auth/idp-info` (path + `IdpInfoResponse` schema) matching existing Auth-section conventions.

# Final idp-info response shape
`GET /v1/auth/idp-info` (PUBLIC, unauthenticated, no CSRF) → `200`
```json
{ "display_name": "Keycloak", "issuer": "http://localhost:8080/realms/harvoost" }
```
- `display_name` resolution order: `OIDC_DISPLAY_NAME` env (trimmed, authoritative) → derived from discovery issuer host (e.g. `login.microsoftonline.com`, `localhost`) → literal `"your identity provider"`.
- `issuer`: from the cached OIDC discovery doc (reuses `OidcService.getDiscovery()` — no second fetch). If discovery is unreachable, falls back to the configured `OIDC_ISSUER_URL` and logs a warning; the endpoint never fails on a transient IdP outage.

# Contract confirmation (canonical block — backend side)
- `GET /v1/auth/idp-info` — PUBLIC, returns `{ display_name, issuer }`. DONE.
- `POST /v1/auth/oidc/login` body `{ client_kind: "web" }` → `201 { authorization_url, opaque_state_id (uuid) }`. Confirmed: `LoginInitSchema` accepts `client_kind: 'web'` (default 'web') and ignores `redirect_uri` (left ignored — the frontend stops sending it; server-built redirect_uri from `OIDC_REDIRECT_URI_WEB` is the single source of truth). NestJS POST defaults to 201. `opaque_state_id` is the `auth_pending.id` UUID. No code change needed.
- `POST /v1/auth/oidc/callback` body `{ code, state, opaque_state_id (uuid) }` → sets session cookie. Confirmed: `OidcCallbackSchema` requires exactly those three fields; the callback looks up `auth_pending` by `opaque_state_id`, verifies `state` matches and not expired, exchanges the code, validates the id_token, mints the session, sets the HttpOnly cookie, deletes the row. The `opaque_state_id` returned by `/oidc/login` is the same value the callback validates against (`auth_pending.id`, `UUID PRIMARY KEY DEFAULT gen_random_uuid()` — see migration `20260522180000_auth_pending`). State round-trips correctly end-to-end. No code change needed.
- Browser callback lands on `http://localhost:3000/auth/callback` (Option B-web): enforced by `OIDC_REDIRECT_URI_WEB` + realm allowlist. DONE.

# What downstream agents need to know
- DECISION: `OIDC_DISPLAY_NAME` is the authoritative source for the IdP display name (the OIDC discovery doc carries no human-friendly name). `.env` (dev) = `Keycloak`; `.env.example` (prod-parity template) = `Microsoft Entra ID`. No `NEXT_PUBLIC_OIDC_DISPLAY_NAME` build-arg was added — the `idp-info` endpoint supersedes it (per the user decision). The frontend lane should fetch `GET /v1/auth/idp-info` for the copy.
- The login/callback handlers were already correct for the contract — the only Lane B backend change required was the redirect_uri value (env + realm). No handler logic changed.
- `OidcService.getDiscovery()` is reused by `idp-info` (boot-cached, 1h TTL) — no second discovery fetch was introduced.
- The prod fail-closed Entra OIDC path is untouched; all changes are additive/config-only for prod (dev gets the Keycloak values).
- The repo `lint` script for `@harvoost/api` is pre-existingly broken (`ESLint couldn't find an eslint.config.js` — ESLint v9 migration not done). This predates this work and is not a regression; typecheck (`tsc --noEmit`) is the working gate and passes clean.

# Open questions / unknowns
- None blocking.

# Verification evidence — FLAGS for the verify step
- **REALM RE-IMPORT REQUIRED (critical):** `infra/keycloak/realm.json` changed, but Keycloak only imports the realm on first start. The running stack still has the old allowlist (no `/auth/callback`) until re-imported. The planned `docker compose down && docker compose up -d --build` re-imports it. Until then, the live round-trip will still fail with `Invalid redirect_uri` at Keycloak. The `--build` is also required so the new `NEXT_PUBLIC_WEB_BASE_URL` build-arg is baked into the web bundle.
- `pnpm --filter @harvoost/api test` → **227 passed (227)**, 30 test files. Includes the 5 new `idp-info` tests.
- `pnpm --filter @harvoost/api exec tsc --noEmit` → **EXIT 0** (clean).
- Full repo: api 227 + web 12 + shared 91 + db 21 + jobs 40 = **391 passed**, plus the **1 known pre-existing** failure `@harvoost/shared > RbacScopeService > throws RbacError on empty requesterId` (accepted baseline; in `packages/shared`, outside this change set). No other regressions. (Baseline was stated as 381+1; the +10 delta is the 5 new idp-info tests plus tests added beyond the stated baseline — none in my territory regressed.)
