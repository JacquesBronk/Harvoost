---
phase: 04-build
agent: backend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Implemented the BACKEND lane of INC-008 (GitHub #11) — OIDC RP-initiated logout,
provider-agnostic per ADR-0001, using **Option B** (no id_token persisted, no
migration). On `POST /v1/auth/logout` the controller now revokes the local
session and clears the cookie FIRST, then computes the IdP end-session URL from
the same OIDC discovery mechanism used for login. The response changed from
`{ ok: true }` to `{ ok: true, logout_url: string | null }`. The frontend
navigates the browser to `logout_url` (to end the IdP SSO session so the next
login shows the IdP form / allows a different user), falling back to a local
`/login` redirect when `logout_url` is `null`.

# PINNED CONTRACT (unchanged from dispatch — implemented exactly)
`POST /v1/auth/logout` → 200 `{ ok: true, logout_url: string | null }`
- `logout_url` = discovered `end_session_endpoint` +
  `?client_id=<OIDC_CLIENT_ID>&post_logout_redirect_uri=<WEB_ORIGIN + /login>`.
- `logout_url` = `null` when no `end_session_endpoint` is discovered (IdP omits
  it) OR discovery is momentarily unreachable.

# Exact logout_url construction
1. Controller builds the redirect from trusted config ONLY:
   `const postLogoutRedirectUri = new URL('/login', this.env.WEB_ORIGIN).toString();`
   (dev → `http://localhost:3000/login`; prod → `<WEB_ORIGIN>/login`).
   It is NEVER derived from request input (no `next`/`returnTo`/body/query/
   Referer/Origin) — closes CWE-601 open redirect.
2. Controller calls `oidc.buildEndSessionUrl({ postLogoutRedirectUri })`.
3. `OidcService.buildEndSessionUrl` fetches the cached discovery doc (same
   `getDiscovery()` used by login), reads `end_session_endpoint`, and builds:
   `new URL(end_session_endpoint)` + `searchParams: client_id=OIDC_CLIENT_ID`,
   `post_logout_redirect_uri=<the server-built value>`. Optional `logout_hint`
   is appended only if a value is passed (currently the controller passes none —
   Option B sends no id_token / hint; the param is plumbed for future use).
   Returns the `.toString()`.

# Fallback behavior (graceful, never throws)
- `buildEndSessionUrl` returns `null` (no throw) when the discovery doc has no
  `end_session_endpoint`, or when `getDiscovery()` throws (IdP unreachable) —
  it logs a warning and returns `null`.
- `logout()` always performs local teardown (session revoke + `clearCookie`)
  BEFORE building the URL, so local logout succeeds regardless of IdP state.
- No-token path still clears the cookie and still returns the built (or `null`)
  `logout_url`; no `UPDATE sessions` runs when there is no token.

# How it stays provider-agnostic
- Uses the existing discovery mechanism (`${OIDC_ISSUER_URL}/.well-known/
  openid-configuration`) — the only thing that varies between Keycloak (dev) and
  Entra/Azure (prod) is `OIDC_ISSUER_URL`.
- The end-session path comes ENTIRELY from the discovered `end_session_endpoint`
  — no hardcoded Keycloak realm path, no `openid-connect` literal, no
  Keycloak-only params. A unit test proves it builds correctly against an
  Entra-style `https://login.microsoftonline.com/.../oauth2/v2.0/logout`
  endpoint and asserts the result contains neither `/realms/` nor
  `openid-connect`.

# Files touched
- apps/api/src/auth/oidc.service.ts (modified) — added
  `buildEndSessionUrl({ postLogoutRedirectUri, logoutHint? }): Promise<string | null>`.
- apps/api/src/auth/auth.controller.ts (modified) — `logout()` now returns
  `{ ok: true, logout_url }`, revokes session + clears cookie first, builds the
  redirect from `WEB_ORIGIN` only.
- apps/api/test/unit/logout-rp-initiated.test.ts (new) — 11 tests covering the
  service URL builder (build, provider-agnostic non-Keycloak issuer, null on
  missing endpoint, null on unreachable discovery, optional logout_hint) and the
  controller logout (revoke+clear+logout_url, CWE-601 input-ignored, prod
  WEB_ORIGIN, graceful null fallback, no-token path, local-teardown-precedes-URL).
- apps/api/test/unit/cookie-auth.test.ts (modified) — added `buildEndSessionUrl`
  to the oidc stub; relaxed the `{ ok: true }` assertion to `ret.ok === true` +
  `toHaveProperty('logout_url')`.
- apps/api/test/unit/oidc-callback.test.ts (modified) — added
  `buildEndSessionUrl` to the oidc stub; relaxed the `{ ok: true }` assertion the
  same way.

# What downstream agents need to know
- DECISION (Option B): no `id_token` is persisted and NO migration was added.
  Therefore no `id_token_hint` is sent to the IdP. Keycloak will show a brief
  logout-confirmation prompt (expected with Option B). The `logout_hint` param
  is wired through the service but the controller passes nothing for it.
- FRONTEND (apps/web): `handleSignOut` must read `logout_url` from the response.
  If non-null, `window.location.assign(logout_url)` (full browser navigation, not
  `router.push`). If null, fall back to local `/login`. The response shape is now
  `{ ok: true, logout_url: string | null }` (was `{ ok: true }`).
- DEVOPS (infra/keycloak/realm.json): `post_logout_redirect_uri` is
  `WEB_ORIGIN + /login` (dev: `http://localhost:3000/login`). The realm's
  `harvoost-web` post-logout allowlist must include `/login` (currently `"+"`
  inherits the redirectUris which do NOT include `/login`). Without that realm
  change Keycloak will reject the redirect. (Out of my lane — flagged per REPORT
  D2; needs the keycloak volume drop to re-import.)
- ORCHESTRATOR (openapi/contract touch): update `POST /v1/auth/logout` response
  to `{ ok: true, logout_url: string | null }` to match the pinned contract.
- No regressions: INC-002 sign-in round-trip, INC-003/005 session cookie +
  throttle, and bearer/cookie auth are untouched. CSRF behavior on the logout
  POST is unchanged (no decorator/route changes). Token resolution
  (Bearer-then-cookie precedence) and the existing revoke SQL are preserved
  verbatim.

# Open questions / unknowns
- None for the backend lane. The only cross-lane dependency is the Keycloak
  realm post-logout allowlist (devops) — without it Keycloak rejects the
  `/login` redirect, but that is the devops lane's responsibility and was called
  out in the REPORT (D2).

# Verification evidence
- `pnpm --filter @harvoost/api typecheck` → clean (tsc --noEmit, exit 0).
- `pnpm --filter @harvoost/api test` → 47 files, **395 passed (395)**, 0 failed.
  Baseline was 384; +11 from the new logout-rp-initiated.test.ts. The 2 modified
  existing logout assertions did not change test counts.
- `pnpm --filter @harvoost/api test run logout-rp-initiated` → 11 passed (11).
- NOTE: `pnpm --filter @harvoost/api lint` fails repo-wide with "ESLint couldn't
  find an eslint.config.js" (ESLint v9 migration not done in this repo). This is
  a pre-existing, package-wide condition unrelated to INC-008 — not a regression
  introduced by this change.
