# Incident INC-002 — login-entra-only-and-no-keycloak-redirect

GitHub issue: [#2](https://github.com/JacquesBronk/Harvoost/issues/2) — "Login page is Entra-only by copy and won't progress in dev (Keycloak)"
Follow-up to INC-001 (closed via commit c1c0e06).

## Reporter description (verbatim)
> After fixing #1, the home page now correctly redirects unauthenticated visits to `/login`. But the login page has two interrelated problems:
>
> 1. **Copy is hardcoded to Microsoft Entra ID** ("Authentication is handled by Microsoft Entra ID…" / "Continue with Microsoft") even though dev runs on Keycloak per ADR-0001. The OIDC code path is provider-agnostic; the UI must not assume Microsoft.
> 2. **Clicking the sign-in button does not progress to Keycloak.** The reporter stays on `/login` with no visible redirect. The backend `POST /v1/auth/oidc/login` is curl-verified to return a correct Keycloak authorize URL with PKCE, so the hang is on the client side.

## Triage (orchestrator — incident-responder skipped per user-directed hotfix flow, as in INC-001)
- **Severity:** sev-2 — dev/demo sign-in is fully blocked; no production impact (prod OIDC path intentionally fail-closed, deferred to v0.2.0).
- **Scope:** `apps/web/app/login/page.tsx` (client-side click handler + hardcoded copy). Backend `POST /v1/auth/oidc/login` confirmed correct (curl returns valid Keycloak authorize URL w/ PKCE). Stack: all app containers healthy.
- **Reproduction:** `docker compose up -d --build` → open `http://localhost:3000/` → resolves to `/login` → click "Continue with Microsoft" → page does not navigate to Keycloak; user remains on `/login`.
- **Blast radius:** every dev/demo sign-in attempt. Two distinct defects: (1) cosmetic IdP-naming, (2) functional no-redirect — possibly linked.
- **Rollback recommended:** no — INC-001 fix (CSP nonce) is correct and must stay; this is a forward fix on the login page only.

## Suspected causes (from issue, ranked, do NOT lock in)
1. JS exception in `handleSignIn` before `window.location.assign` is reached (apiFetch throwing, bad `env.WEB_BASE_URL`, providers/TanStack issue).
2. CSP blocking the cross-origin navigation to `harvoost.localhost:8080` (closest to INC-001 — worth a quick CSP-diff sanity check).
3. CSRF middleware rejecting the POST (X-Requested-With confirmed added in #1).
4. redirect_uri mismatch (`/auth/callback` vs backend's `/v1/auth/callback`) — would break the round-trip *after* Keycloak, not the redirect itself.
5. Button not actually wired in the bundle after the CSP fix (the cause to most want ruled out).

## Next step
Dispatch `debugger` to reproduce in a real browser (Playwright headed via tests/e2e/, capturing console + network) or via a curl-simulated fetch, isolate the root cause of the no-redirect, and classify the copy bug (cosmetic vs root-cause-linked). Output: ROOT_CAUSE.md + HOTFIX_PLAN.md + fix-lane recommendation. **Does NOT implement the fix.**

## Acceptance criteria (from issue)
1. Copy reflects the configured IdP (not unconditionally "Microsoft Entra ID"). Default approach: `NEXT_PUBLIC_OIDC_DISPLAY_NAME` env var, build-bakeable via the build-arg pattern established in INC-001.
2. Clicking sign-in on a fresh `/login` redirects to the Keycloak authorize endpoint within ~2s.
3. Authenticating as `alice@harvoost.local` / `dev-alice-pass` round-trips back, session cookie set, lands on `/timesheets`.
4. `pnpm test` stays green (381 passing + 1 pre-existing RbacScopeService failure).
5. CHANGELOG `[Unreleased] / Fixed` entry referencing #2.

## Scope guardrails
Do NOT rip out the real-Entra-ID-in-production code path (v0.2.0, intentionally fail-closed). Other TODO_INVENTORY items stay deferred to v0.2.0.

## Resolution — status: CLOSED (2026-05-23, commit 23f0311, closes #2)
Root cause was NOT the reported symptom. The "stays on /login" was a stale cached pre-INC-001 bundle (hard-refresh fixes it); all 5 ranked suspects were refuted with live-browser evidence. The real, deterministic bug was a three-way OIDC contract mismatch breaking the round-trip *after* Keycloak (B1 dead `redirect_uri`; B2 callback path `/v1/auth/callback` vs served `/auth/callback` + realm allowlist; B3 missing `opaque_state_id`). The copy bug was independent/cosmetic.

Fixes shipped (frontend-dev + backend-dev, 2 passes):
1. **Round-trip:** `OIDC_REDIRECT_URI_WEB`→`/auth/callback` (+ realm.json allowlist), `opaque_state_id` round-tripped via `sessionStorage`, dead client `redirect_uri` dropped.
2. **Copy:** new public `GET /v1/auth/idp-info` (user chose the endpoint over the env-var default) drives provider-agnostic copy — `OIDC_DISPLAY_NAME`=Keycloak(dev)/Microsoft Entra ID(prod) + discovery issuer.
3. **Post-login crash (newly surfaced, user-approved in-scope):** `/v1/auth/me` now returns `display_name` (email fallback); `<Avatar>` is null/empty-safe — fixed the `name.trim()` React-error-boundary crash on `/timesheets`.
4. **Latent footgun:** `NEXT_PUBLIC_WEB_BASE_URL` baked as a Docker build-arg (mirrors INC-001).

Verification: `pnpm test` 404 pass + 1 known pre-existing `RbacScopeService` fail; clean `docker compose up -d --build` (note: Keycloak `KC_DB=dev-file` persists its volume across `down`, so a realm change requires dropping the `harvoost-keycloak-data` volume to re-import — captured for future incidents); live Playwright `chromium-live` 5/5 — alice@harvoost.local & bob land on a fully-rendered `/timesheets`. Real-Entra-in-prod path untouched (fail-closed, v0.2.0).

Follow-ups (NOT done — deferred): contract test asserting web⇄backend OIDC request/response shapes; single-source-of-truth for the callback path; build-time assertion that every browser-consumed `NEXT_PUBLIC_*` is a declared Dockerfile build-arg. See ROOT_CAUSE.md §Prevention.
