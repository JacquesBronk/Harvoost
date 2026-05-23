# INC-002 — Hotfix plan

Scope guardrail: make **dev/Keycloak sign-in work end-to-end** + make the **copy IdP-agnostic**. Do NOT remove or
alter the real-Entra-ID-in-production OIDC path (fail-closed, deferred to v0.2.0). Do NOT touch `.github/`.

Two fix lanes. **Lane B (functional round-trip) is the load-bearing fix** for acceptance criteria #2/#3; Lane A is
cosmetic.

## Lane B — functional sign-in round-trip (frontend-dev + backend-dev)

Pick **one** of the two callback-path conventions below and apply it consistently. **Recommended: Option B-web**
(make the browser callback land on the existing web page `/auth/callback`) — it is the smallest, frontend-only-ish
change and keeps the API path namespace clean.

### Option B-web (RECOMMENDED): land the browser on the web app's `/auth/callback`

#### Files Changed
- `apps/web/app/login/page.tsx` — **frontend-dev**
  - Stop sending a dead `redirect_uri`; send `{ client_kind: 'web' }` to match `LoginInitSchema`
    (`auth.controller.ts:27-29`). (Or send both, but `redirect_uri` is ignored by the backend — see RC §B1.)
  - Fix `OidcLoginResponse` (lines 11-14): replace `state: string` with `opaque_state_id: string` to match the
    backend response.
  - **Persist `opaque_state_id`** before navigating (e.g. `sessionStorage.setItem('oidc_opaque_state_id', resp.opaque_state_id)`)
    so the callback page can send it back (fixes RC §B3). Then `window.location.assign(resp.authorization_url)`.
- `apps/api/src/config/env.ts:27` and root `.env:15` — **backend-dev / devops**
  - Change `OIDC_REDIRECT_URI_WEB` default + `.env` value from `http://localhost:3000/v1/auth/callback` to
    `http://localhost:3000/auth/callback` (the path the web app actually serves — `apps/web/app/auth/callback/page.tsx`).
- `infra/keycloak/realm.json:49-51` — **backend-dev / devops**
  - Add `http://localhost:3000/auth/callback` to `harvoost-web.redirectUris` (keep `/v1/auth/callback` if any
    legacy/tray path still needs it). The browser-facing redirect_uri must be in the allowlist or Keycloak refuses it.
- `apps/web/app/auth/callback/page.tsx:30-36` — **frontend-dev**
  - Read `opaque_state_id` from `sessionStorage`, include it in the `/v1/auth/oidc/callback` POST body
    `{ code, state, opaque_state_id }` to satisfy `OidcCallbackSchema` (`auth.controller.ts:31-35`); clear it after.

### Option B-api (alternative): keep `/v1/auth/callback`, add a web route that proxies to the callback page
- Would require a new `apps/web/app/v1/auth/callback/page.tsx` (or a Next rewrite) — more surface area, pollutes the
  web route namespace with an API-shaped path. NOT recommended unless the realm allowlist must stay frozen.

### Latent co-location fix (do alongside Lane B — closes the INC-001 footgun)
- `docker/Dockerfile.web` — **devops/backend-dev**
  - Add `ARG NEXT_PUBLIC_WEB_BASE_URL=http://localhost:3000` + `ENV NEXT_PUBLIC_WEB_BASE_URL=$NEXT_PUBLIC_WEB_BASE_URL`
    in the `build` stage (mirror the existing `NEXT_PUBLIC_API_BASE_URL` block, lines 42-43) so `env.WEB_BASE_URL` is
    baked instead of falling back. Pass it from `docker-compose.yml` `web.build.args`.
  - (Optional, larger) consider a runtime-config pattern so `API_BASE_URL`/`WEB_BASE_URL` aren't hardcoded literals;
    out of scope for this hotfix but note in v0.2.0 backlog.

## Lane A — IdP-agnostic copy (frontend-dev) [cosmetic, independent]

**Recommended approach: `NEXT_PUBLIC_OIDC_DISPLAY_NAME` env var, build-baked** (the orchestrator default, and the
right call here — there is no existing OIDC capabilities/idp-info endpoint; only chatbot has `capabilities`, confirmed
by grep). A capabilities endpoint would be over-engineering for a display string; generic copy ("your organisation's
identity provider") is an acceptable fallback if no display name is set.

#### Files Changed
- `apps/web/src/lib/env.ts` — **frontend-dev**
  - Add `OIDC_DISPLAY_NAME: process.env.NEXT_PUBLIC_OIDC_DISPLAY_NAME ?? 'your identity provider'`.
- `apps/web/app/login/page.tsx:53-54,64` — **frontend-dev**
  - Replace "Authentication is handled by Microsoft Entra ID; MFA…" with copy that interpolates
    `env.OIDC_DISPLAY_NAME` (e.g. "Authentication is handled by {OIDC_DISPLAY_NAME}…").
  - Replace button label "Continue with Microsoft" with "Continue with {OIDC_DISPLAY_NAME}" (or a neutral "Sign in").
- `docker/Dockerfile.web` — **devops/backend-dev**
  - Add `ARG NEXT_PUBLIC_OIDC_DISPLAY_NAME=Keycloak (dev)` + `ENV NEXT_PUBLIC_OIDC_DISPLAY_NAME=$NEXT_PUBLIC_OIDC_DISPLAY_NAME`
    in the `build` stage (build-time baking — runtime `environment:` is too late, per the file's own comment).
- `docker-compose.yml` (`web.build.args`, ~line 211-217) — **devops**
  - Pass `NEXT_PUBLIC_OIDC_DISPLAY_NAME: Keycloak (dev)` so dev shows the correct IdP name.

## Tests to add / adjust
- **Promote a live e2e** (or extend `tests/e2e/specs/oidc-flow.spec.ts`) to assert the FULL round-trip lands on
  `/timesheets` with `harvoost_session` set (currently the live spec is gated behind `E2E_LIVE=1`). After Lane B this
  should pass against the docker stack. Use the seeded creds `alice@harvoost.local` / `dev-alice-pass` (NOTE: username
  is the **full email** — realm has `registrationEmailAsUsername: true`; my repro initially failed by typing `alice`).
- **Add a contract assertion** that the web `/oidc/login` request body and `/oidc/callback` request body match the
  backend Zod schemas (`LoginInitSchema`, `OidcCallbackSchema`) — would have caught B1/B3.
- **Copy test (hermetic)**: assert the login button/label reflect `NEXT_PUBLIC_OIDC_DISPLAY_NAME` and do NOT contain
  "Microsoft" when the env var is set.
- `oidc-flow.spec.ts:18,16` doc comments still say "Continue with Microsoft" — update the button name matcher there
  after Lane A.

## Suggested implementer agents
- **backend-dev**: `apps/api/src/config/env.ts`, `.env`, `infra/keycloak/realm.json`, `docker/Dockerfile.web` +
  `docker-compose.yml` build-args (or hand the Docker/compose bits to devops).
- **frontend-dev**: `apps/web/app/login/page.tsx`, `apps/web/app/auth/callback/page.tsx`, `apps/web/src/lib/env.ts`,
  e2e/copy tests.

## Throwaway repro specs (orchestrator decision needed)
Archived in `incidents/INC-002/repro/` and **removed from the active `tests/e2e/specs/` suite** (so they don't run in
CI). They were named `_inc002_repro*.spec.ts`:
- `login-redirect.repro.spec.ts` — observes the happy-path click → Keycloak.
- `csp-and-dns.repro.spec.ts` — CSP-violation listener + unresolvable-host simulation.
- `no-hydration.repro.spec.ts` — JS-disabled, proves the "stays on /login" symptom.
- `full-roundtrip.repro.spec.ts` — drives the full sign-in (useful to harden into the live e2e).
Recommendation: **discard** the four ad-hoc repros; instead fold `full-roundtrip` into the canonical
`tests/e2e/specs/oidc-flow.spec.ts` live lane.

## Rollback
- All changes are forward-only edits to source/config; no migrations. To revert: `git revert <hotfix commit>` (or
  restore the four files in Lane B + the env/realm/Dockerfile/compose edits). Reverting restores the current state
  where the *initial* redirect works same-host but the post-Keycloak round-trip is broken. The INC-001 CSP-nonce fix
  (commit c1c0e06) is independent and must NOT be reverted.
