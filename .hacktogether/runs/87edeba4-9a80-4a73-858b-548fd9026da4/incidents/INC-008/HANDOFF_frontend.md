---
phase: incidents/INC-008
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: done
---

# Summary
Wired the web Sign Out flow to OIDC RP-initiated logout (GitHub #11). `handleSignOut`
previously POSTed `/v1/auth/logout` then unconditionally `router.push('/login')`, which
only cleared the local session cookie and never ended the Keycloak/IdP SSO session — so
the next login silently re-authenticated the same user. It now reads the backend's new
`{ ok, logout_url }` response and, when `logout_url` is a valid absolute http(s) URL, does
a REAL full-page browser navigation (`window.location.assign`) to the IdP
`end_session_endpoint` so the SSO cookie is actually cleared and the IdP redirects back to
`/login`. Any failure path — `logout_url: null` (no `end_session_endpoint`), a non-http(s)
value (defense-in-depth), a non-2xx response, or a thrown/network error — falls back to the
original local `router.push('/login')` so a network blip never strands the user. The
navigation-decision logic is extracted into a pure `resolveLogoutNavigation` helper (plus a
`requestLogout` POST fn) so it is testable under the node-env `apps/web/__tests__`
convention without rendering the React AppShell.

# Files touched
- apps/web/src/lib/logout.ts (new) — `requestLogout()` (POST, preserves `credentials: 'include'` + `X-Requested-With` CSRF, returns `{ ok, logout_url }` or `null` on any failure) and the pure `resolveLogoutNavigation()` decision helper + `LogoutNavigation` type. Includes the `isAbsoluteHttpUrl` defense-in-depth guard.
- apps/web/src/lib/api-types.ts (modified) — added `LogoutResponse { ok: boolean; logout_url: string | null }`.
- apps/web/src/components/AppShell.tsx (modified) — `handleSignOut` now `await requestLogout()` → `resolveLogoutNavigation()` → `window.location.assign(url)` for the external case, else `router.push('/login')`. Dropped the now-unused `env` import (logout.ts owns the URL build).
- apps/web/__tests__/inc008-rp-logout.test.ts (new) — 13 hermetic node-env tests.

# What downstream agents need to know
- PINNED CONTRACT consumed exactly as specified: `POST /v1/auth/logout` → 200 `{ ok: true, logout_url: string | null }`. The FE only navigates externally when `logout_url` is a non-empty absolute `http(s)://` URL; otherwise it falls back to `/login`. The backend lane must keep this shape.
- `window.location.assign` (NOT `router.push`) is intentional for the external case — it must be a real navigation to the external IdP origin to clear the SSO cookie. Tested by modeling `assign`/`router.push` as spies in the composition tests.
- CSRF + cookie behavior on the POST is unchanged (`credentials: 'include'`, `X-Requested-With: XMLHttpRequest`) and asserted in the test.
- No new dependencies. No changes to `query-client.ts`. Stayed entirely within `apps/web/*` — no `apps/api`, `infra`, `openapi.yaml`, `tests/contract`, or `.github/` touched.
- This change is inert until the backend lane returns a non-null `logout_url`; until then `handleSignOut` behaves exactly as before (falls back to `/login`), so no regression while lanes land out of order. The realm lane must allowlist the web `/login` as a post-logout redirect (REPORT D2) or Keycloak rejects the redirect — that is the devops/realm lane's job, not FE.

# Open questions / unknowns
- None.

# Verification evidence
- `pnpm --filter @harvoost/web test` → 15 files, 180 passed (baseline 167 + 13 new INC-008 tests). No regressions in INC-001/002/003/004/005/006/007 or FEAT-001/002 suites.
- `pnpm --filter @harvoost/web typecheck` → clean (tsc --noEmit, no errors).
