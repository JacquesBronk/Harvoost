---
phase: INC-002
agent: debugger
started: 2026-05-23
finished: 2026-05-23
status: complete (triage only — fix NOT implemented, per instructions)
---

# Summary
Triaged GitHub issue #2 (login page Entra-only copy + no Keycloak redirect) against the running, healthy
docker-compose stack. With no local browser, I drove the real bundled Chromium via the existing Playwright infra
(`tests/e2e/`, chromium-mocked project, `E2E_SKIP_WEB_SERVER=1`) pointed at the live stack, capturing console,
pageerror, requestfailed, response, framenavigated, and CSP-violation events. The same-host happy path actually
WORKS (POST 201 → `window.location.assign` reaches Keycloak's login page, no errors, no CSP violations), so the
reporter's "stays on /login" symptom is a stale/pre-hydration cache artifact of the just-fixed INC-001 CSP state
(proved by a JS-disabled repro), with a latent off-host variant (API base URL is a baked literal). The real,
deterministic code bug is a three-way frontend↔backend OIDC contract mismatch that breaks the round-trip AFTER
Keycloak. The Entra-ID copy is purely cosmetic. Wrote ROOT_CAUSE.md + HOTFIX_PLAN.md; made no source changes.

# Files touched
- .hacktogether/runs/.../incidents/INC-002/ROOT_CAUSE.md (new)
- .hacktogether/runs/.../incidents/INC-002/HOTFIX_PLAN.md (new)
- .hacktogether/runs/.../incidents/INC-002/repro/*.repro.spec.ts (new — 4 archived throwaway specs)
- (No source files changed. Throwaway specs were created under tests/e2e/specs/ then removed from the suite.)

# What downstream agents need to know
- Suspect verdicts (positive evidence): #1 REFUTED same-host (latent off-host variant CONFIRMED — hardcoded
  API_BASE_URL literal); #2 (CSP) REFUTED — zero securitypolicyviolation events, no navigate-to directive applies;
  #3 (CSRF) REFUTED — POST returns 201; #4 (redirect_uri) CONFIRMED but post-Keycloak only; #5 (button not wired)
  REFUTED — hydrated button drives the full flow. The actual same-host symptom = pre-hydration/stale-cache click
  (not on the suspect list).
- THE load-bearing bug is a 3-way contract mismatch (RC §B): (B1) web sends `redirect_uri` but `LoginInitSchema`
  ignores it; (B2) backend `OIDC_REDIRECT_URI_WEB`=`/v1/auth/callback` but the web callback page is at
  `/auth/callback`; (B3) web callback POSTs `{code,state}` but `OidcCallbackSchema` requires `opaque_state_id`
  (which is never persisted/returned). Recommended fix lane: Option B-web (land browser on `/auth/callback`).
- Copy bug = COSMETIC, independent of the redirect. Recommended fix: `NEXT_PUBLIC_OIDC_DISPLAY_NAME` env var,
  build-baked via the Dockerfile build-arg pattern (no OIDC capabilities endpoint exists — confirmed by grep).
- Also bake `NEXT_PUBLIC_WEB_BASE_URL` as a build-arg (Dockerfile.web currently only bakes
  NEXT_PUBLIC_API_BASE_URL) to close the INC-001 footgun class.
- Seeded creds for the live e2e: username is the FULL email `alice@harvoost.local` / `dev-alice-pass`
  (realm has registrationEmailAsUsername: true). Do NOT type bare `alice`.
- Fix lanes: backend-dev (env.ts, .env, realm.json, Dockerfile/compose build-args) + frontend-dev (login page,
  callback page, lib/env.ts, copy/e2e tests). INC-001 CSP fix (c1c0e06) must NOT be reverted.

# Open questions / unknowns
- The exact reporter environment is unconfirmed: same-host stale-cache (most likely) vs off-host API-base failure.
  If the orchestrator can relay one DevTools check to the reporter: after a HARD refresh of /login, click sign-in
  and report (a) any console error, (b) any "Cannot reach the API" toast, (c) the Network tab status of
  POST /v1/auth/oidc/login. This disambiguates H6 (cache) vs H1b (off-host). Either way, Lane B is required for #3.

# Verification evidence
- `docker ps` → harvoost-web/api/keycloak/postgres all `healthy`.
- `curl -sI http://localhost:3000/login` → CSP carries `nonce-...`; served HTML scripts all nonced.
- Playwright `login-redirect.repro.spec.ts` → click → POST 201 → FINAL URL = harvoost.localhost:8080/.../auth;
  PAGE ERRORS [], CONSOLE [], FAILED REQUESTS [].
- `csp-and-dns.repro.spec.ts` → CSP VIOLATIONS []; unresolvable-host → chrome-error page (NOT stays-on-login).
- `no-hydration.repro.spec.ts` (JS disabled) → URL after click = http://localhost:3000/login (matches symptom).
- `docker exec harvoost-web grep ... .next/static/chunks` → env module: API_BASE_URL="http://localhost:3001"
  (baked literal), WEB_BASE_URL = process.env.NEXT_PUBLIC_WEB_BASE_URL ?? "http://localhost:3000" (not baked).
- `git diff --stat` → only run-state + new INC-002 folder; no source changes; throwaway specs removed from suite.
