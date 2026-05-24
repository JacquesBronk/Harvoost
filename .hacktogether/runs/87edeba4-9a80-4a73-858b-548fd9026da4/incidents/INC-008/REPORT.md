# INC-008 — Sign Out doesn't end the Keycloak session (no OIDC RP-initiated logout)

- **GitHub issue:** #11 (labeled `bug`)
- **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
- **Opened:** 2026-05-24
- **Severity:** High (security/usability) — logout is local-only; the Keycloak SSO cookie persists, so the next login silently re-authenticates the SAME user. No way to switch users.
- **Flow:** directed hotfix, **debugger SKIPPED** (user-authorized — the issue is precisely diagnosed; orchestrator grounded it directly). HITL gates: (a) before fix dispatch, (b) before push.

## Root cause (grounded in code — confirms the issue)
- `apps/api/src/auth/auth.controller.ts:306-326` `logout()` only does `UPDATE sessions SET revoked_at = NOW()` + `res.clearCookie(SESSION_COOKIE_NAME)` + returns `{ ok: true }`. **No IdP redirect.**
- `apps/api/src/auth/auth.controller.ts:267` the session INSERT stores `(user_id, kind, expires_at, refresh_token_hash, user_agent, ip)` — **the `id_token` is validated at callback (`oidc.service.validateIdToken`, :194) but NOT persisted**, so there's no `id_token_hint` available for RP-initiated logout.
- `apps/api/src/auth/oidc.service.ts:22` the discovery type already carries `end_session_endpoint` (discovered) — nothing uses it.
- `apps/web/src/components/AppShell.tsx:116-127` `handleSignOut` POSTs `/v1/auth/logout` then `router.push('/login')` — no IdP navigation.
- `packages/db/prisma/schema.prisma:550` `model Session` has `refreshTokenHash`, `revokedAt`, etc. — **no `id_token` column**.
- `infra/keycloak/realm.json` `harvoost-web` client: `"post.logout.redirect.uris": "+"` ⇒ the allowed post-logout redirect set = the 3 `redirectUris` (`/auth/callback`, `/v1/auth/callback` ×2). **`/login` is NOT allowlisted**, so a `post_logout_redirect_uri=.../login` would be rejected by Keycloak without a realm change.

## Fix plan (RP-initiated logout)
1. **Backend** — on logout, after revoking the local session, build + return the IdP logout URL: `end_session_endpoint?id_token_hint=<id_token>&post_logout_redirect_uri=<web /login>`; `oidc.service` exposes `end_session_endpoint` + a URL builder.
2. **Frontend** — `handleSignOut` navigates the browser to the returned logout URL (`window.location.assign`) instead of `router.push('/login')`.
3. **Realm** — allow the web `/login` (or origin) as a post-logout redirect (realm.json) → requires the keycloak-volume drop to re-import (see [[keycloak-realm-reimport]]).
4. (If id_token_hint approach) **DB** — add an `id_token` column to `sessions` (migration) + store it at callback.

## Decisions for gate (a)
- **D1 — logout style:** (A) `id_token_hint` (persist the id_token → prompt-free RP logout; needs a migration + stores a JWT) — the issue's recommended/cleaner option; vs (B) fallback (`client_id` + `post_logout_redirect_uri`, no storage/migration, Keycloak shows a brief logout-confirmation prompt).
- **D2 — realm change:** `/login` (or the web origin) must be added to the post-logout allowlist (realm.json) → keycloak volume drop for re-import. Confirm acceptable.

## Acceptance criteria (from issue #11)
- After Sign Out, initiating login again must show the Keycloak login form and allow authenticating as a DIFFERENT user.

## Scope guardrails
- Do NOT regress INC-001..007 / FEAT-001 / FEAT-002. Do NOT touch `.github/`. Preserve the working sign-in round-trip (INC-002) + the session/cookie + throttle behavior (INC-003/005). If a migration is added, additive only.

## HITL gates
- **(a)** before fix dispatch (D1 + D2).  **(b)** before push (`closes #11`).
