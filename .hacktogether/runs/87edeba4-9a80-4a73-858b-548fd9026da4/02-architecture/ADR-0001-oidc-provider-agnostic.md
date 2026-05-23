# ADR-0001: OIDC is provider-agnostic; Keycloak is the dev IdP

## Status

Proposed — 2026-05-22T23:30:00Z. Pending HITL approval at the predeploy gate.

Replaces partial decision **r0 Auth: "Entra ID OIDC only"** with **"OIDC (provider-agnostic; Entra ID in prod, Keycloak in dev, any compliant IdP supported)"**. The r2 decision to lock `LLM_PROVIDER=openai` is orthogonal and unchanged.

---

## Context

Three open issues converge on the same fix:

1. **F3 — Real Entra OIDC JWKS validation is unimplemented.** `apps/api/src/auth/auth.controller.ts:46-87` carries a `TODO(build-phase-followup)` for signature/audience/nonce/iss/exp validation against the Entra JWKS. Production boot-invariants in `apps/api/src/config/env.ts:76-86` refuse `MOCK_OIDC=true` AND the real branch is empty, so a production deploy fails closed: sign-in returns `OIDCFailureError` with a 500. Boot-invariants prevent a security bypass but also prevent any user signing in.

2. **B3 — Mock-OIDC is active-debug-code attack surface.** The mock-OIDC mode (`MOCK_OIDC=1`) accepts `{ email, displayName }` from a public POST body and provisions an admin user if the email matches `BOOTSTRAP_ADMIN_EMAIL`. The `BearerAuthGuard` accepts `X-Mock-User-Id` headers as a bypass when `MOCK_OIDC=1 && NODE_ENV!=production && !ENTRA_TENANT_ID`. The security review noted this is a misconfiguration-class risk: even with the boot invariants, the code path exists and represents future-misconfiguration exposure.

3. **Dev/test ergonomics.** End-to-end tests at `tests/e2e/fixtures/mock-api.ts:301` and `apps/api/test/e2e/*.ts` rely on `X-Mock-User-Id` to authenticate. No realistic OIDC handshake is exercised end-to-end. The first time real OIDC is tested is the first production deploy — exactly the wrong moment.

The user's insight is correct: **OIDC is provider-agnostic by spec.** Microsoft Entra is just one compliant OpenID Connect provider. If we use Keycloak in dev (docker-compose) we exercise the **same real-OIDC code path** against the same `.well-known/openid-configuration` discovery + JWKS validation flow that production uses against Entra. The provider's identity is just an env-driven discovery URL.

This collapses F3 + B3 + dev-ergonomics into a single implementation: one provider-agnostic OIDC client; provider chosen by `OIDC_ISSUER_URL` env var.

---

## Decision

**Endorse the user's proposal with the refinements below.**

### 1. Rename and generalise the auth env vars

| Old (provider-named) | New (provider-agnostic) | Notes |
|---|---|---|
| `ENTRA_TENANT_ID` | (REMOVED) | Tenant is encoded in the issuer URL itself. |
| `ENTRA_CLIENT_ID` | `OIDC_CLIENT_ID` | The relying-party client id at the IdP. |
| `ENTRA_CLIENT_SECRET` | `OIDC_CLIENT_SECRET` | The relying-party client secret (confidential client only). |
| `ENTRA_REDIRECT_URI_WEB` | `OIDC_REDIRECT_URI_WEB` | Unchanged shape. |
| — (was missing) | `OIDC_REDIRECT_URI_TRAY` | Tray's redirect URI; e.g., `harvoost://auth/callback`. Already documented in STACK.md. |
| — (NEW) | `OIDC_ISSUER_URL` | The issuer URL; the discovery doc is fetched from `${OIDC_ISSUER_URL}/.well-known/openid-configuration`. **This is the only env var that changes between providers.** |
| `MOCK_OIDC` | **DELETED** | Entire mock-OIDC mode is removed (resolves B3). |

**Production value** (Entra): `OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0`.
**Dev value** (Keycloak in docker-compose): `OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost`.

### 2. Delete mock-OIDC entirely

The boot invariants that refuse `MOCK_OIDC=true` in production go away because `MOCK_OIDC` no longer exists. The `X-Mock-User-Id` header bypass in `BearerAuthGuard` is removed. The mock branches in `auth.controller.ts` are deleted.

The thing replacing it for dev is **a real OIDC handshake against a real Keycloak realm** — same code path as production. There is no "mock mode" — there is only OIDC, against whatever IdP the env points to.

### 3. Add Keycloak to docker-compose with seeded realm

A new `keycloak` service in `docker-compose.yml` (image `quay.io/keycloak/keycloak:25.x`, ~512 MB RAM at idle, ~3s boot) imports a realm export from `infra/keycloak/harvoost-realm.json` on first start. The export seeds:

- Realm: `harvoost`
- Client: `harvoost-web` (public client, redirect URI `http://localhost:3000/v1/auth/callback`) + `harvoost-tray` (public client, custom-scheme redirect URI)
- Users (matching the Alice/Bob/Carol/Dave RBAC fixture):
  - `alice@harvoost.local` (Admin) — password `Alice123!`
  - `bob@harvoost.local` (Financial Manager) — password `Bob123!`
  - `carol@harvoost.local` (Manager) — password `Carol123!`
  - `dave@harvoost.local` (Employee) — password `Dave123!`
- Default passwords are dev-only and documented as such in `infra/keycloak/README.md`.

The role-mapping for Harvoost is done **server-side** by Harvoost itself based on `admin_email_allowlist` + the `user_roles` table — exactly as today. **We do NOT push role claims from Keycloak into Harvoost.** This keeps the IdP's job narrow (proves identity, returns `sub` + `email`) and keeps the role authority server-side (where it must be for security review). Same model in prod with Entra.

### 4. One OIDC validation code path using `jose`

The replacement implementation in `auth.controller.ts` does the following on `POST /v1/auth/oidc/callback`:

1. Read `OIDC_ISSUER_URL` from env. Discover the IdP via `GET ${OIDC_ISSUER_URL}/.well-known/openid-configuration` once at boot; cache the JSON. (Set a TTL of 1 hour with refresh-on-failure for liveness against IdP config rotation.)
2. Resolve the JWKS endpoint from the discovery doc. Use `jose`'s `createRemoteJWKSet(jwksUri, { cooldownDuration: 30_000 })` so JWKS is fetched lazily and refreshed when a kid mismatch occurs.
3. Receive the `code` + `state` from the redirect (web) or the device-code grant result (tray); exchange the code for `{ id_token, access_token, refresh_token }` via the discovered `token_endpoint`.
4. Validate the `id_token`: signature against JWKS, `iss === OIDC_ISSUER_URL` (or `iss` field of the discovery doc, whichever the spec emits), `aud === OIDC_CLIENT_ID`, `exp` in future, `nbf` in past (if present), `nonce === stored_nonce_for_state`.
5. Extract claims: `sub` (canonical user identifier), `email`, `name` (or `preferred_username` fallback).
6. Look up the user by `sub` first (canonical), then by `email` (migration path for existing users whose `users.entra_object_id` column was populated under the old name). If user does not exist, auto-provision per the existing rule: if `email` matches a row in `admin_email_allowlist` or `BOOTSTRAP_ADMIN_EMAIL`, create with `admin` role; otherwise create with `employee` role.
7. Mint the Harvoost session token (unchanged from today: 32-byte base64url, sha256 hash stored in `sessions.refresh_token_hash`, HttpOnly cookie). Existing cookie + bearer machinery is preserved.

The `users.entra_object_id` column is **not renamed in this ADR** — backend-dev will decide whether to (a) keep the column name and treat it as "OIDC sub" semantically, or (b) rename to `oidc_subject` as part of the implementation pass. Both are valid. The schema impact is one ALTER COLUMN. Defer to backend-dev's discretion.

### 5. Claim mapping rationale

- **`sub` (subject)** is the canonical user identifier. The OIDC spec guarantees `sub` is stable and unique within the issuer. For Entra, `sub` is the per-tenant user identifier (NOT the AAD `oid`; AAD's `oid` is also stable but `sub` is the spec-portable choice). For Keycloak, `sub` is the user's UUID. Both work. **Storing `sub` in `users.entra_object_id` (or renamed `oidc_subject`) is the right move.**
- **`email`** is the secondary identifier — used for: (1) bootstrap admin allowlist matching, (2) display, (3) migration lookup if `sub` changes (rare; e.g., re-provisioned IdP tenants). Email is not security-load-bearing for role mapping — `admin_email_allowlist` is a database table the application owns, not a claim from the IdP.
- **Role claims** are explicitly NOT consumed from the IdP. The IdP's role universe is independent of Harvoost's RBAC universe. Harvoost owns its roles in `user_roles`.

### 6. No strategy pattern, no `OIDC_PROVIDER` enum

The user offered a fallback: "or we can just have a strategy pattern with a feature switch/env variable to determine the Auth to use". **This is not needed.** OIDC is the strategy. Adding an enum like `OIDC_PROVIDER=keycloak|entra|auth0|okta` would be a code-level abstraction over a configuration that's already abstracted at the protocol level. The only thing that varies is `OIDC_ISSUER_URL`. No code branches on which IdP is behind that URL.

The reason this matters: every strategy implementation we don't write is one less code path to test, one fewer drift risk, one fewer file for a new dev to read. The OIDC discovery doc IS the strategy.

---

## Consequences

### Pros

- **Resolves F3.** One OIDC implementation, works for Entra in prod and Keycloak in dev — same code, same tests, same code path exercised end-to-end. F3 is no longer "real Entra OIDC TODO"; it becomes "implement OIDC against `OIDC_ISSUER_URL`", which works against Keycloak day one.
- **Resolves B3.** Mock-OIDC code is deleted. Boot-invariants around `MOCK_OIDC` are deleted. `X-Mock-User-Id` header is no longer accepted anywhere. The attack surface disappears.
- **Improves dev/test ergonomics.** Real OIDC flow exercised in dev, in E2E tests, and in production — they share the implementation. First production deploy is no longer the first time real OIDC runs.
- **Future-proof.** If the org swaps Entra for Auth0, Okta, or self-hosted Keycloak, only `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` change. No code change.
- **Architectural consistency with the LLM stack.** The architecture already adopted a provider-agnostic LLM abstraction (Vercel AI SDK, r1). Doing the same for OIDC is the same pattern: one code path, provider chosen by config.

### Cons

- **Test migration cost.** Roughly 50 tests use `MOCK_OIDC=1` + `X-Mock-User-Id` for fast authentication. These need to migrate. Two options:
  - **(a) Unit/integration tests:** Replace `X-Mock-User-Id` with a `TEST_AUTH_BYPASS` env var scoped strictly to `NODE_ENV=test`. The bypass mints a session directly via the existing session-table flow (skipping the OIDC handshake) — same path the OIDC callback uses, just invoked via a test helper. This is a NARROWER bypass than `MOCK_OIDC` because it's gated on `NODE_ENV=test` AND a separate env var AND only callable from within test code. It does NOT expose a public HTTP endpoint that issues sessions to arbitrary emails. **Recommended.**
  - **(b) E2E tests:** Use a Playwright helper that performs the real Keycloak login flow once per worker, captures the session cookie, and reuses it. ~10-30 lines of helper code. Slower (1-2s per worker startup) but fully realistic.
- **Operational surface.** Devs need to run a Keycloak container (~512 MB). Acceptable cost for the test realism gain. Keycloak boots in ~3s and only consumes RAM when actively used.
- **Onboarding ergonomics.** A new dev runs `docker compose up -d` and waits for Keycloak to be healthy before they can log in. The compose `healthcheck` for Keycloak will gate `apps/api` boot via `depends_on: { keycloak: { condition: service_healthy } }`.
- **Migration of existing user rows.** Any row in `users` with `entra_object_id` populated under the old mock-OIDC path (e.g., `mock-${email}`) will not match a real Keycloak `sub`. The fallback email lookup (step 6 above) handles this transparently — on first real OIDC login the `entra_object_id`/`oidc_subject` column is updated to the real `sub`. This is a one-time silent migration per user.

### Migration steps (file-by-file)

Order matters — devops/backend-dev should follow this sequence in the next implementation pass:

1. **`infra/keycloak/harvoost-realm.json` (new)** — Realm export with `harvoost-web` + `harvoost-tray` clients + 4 seeded users + default password policy "dev only".
2. **`infra/keycloak/README.md` (new)** — One-page note: how to re-export the realm if you change it via the Keycloak admin UI, password values, OIDC_ISSUER_URL for dev.
3. **`docker-compose.yml`** — Add `keycloak` service (image, ports `127.0.0.1:8080:8080`, command `start-dev --import-realm`, volume mount `./infra/keycloak/harvoost-realm.json:/opt/keycloak/data/import/harvoost-realm.json:ro`, healthcheck on `/health/ready`).
4. **`apps/api/src/config/env.ts`** — Rename `ENTRA_*` → `OIDC_*`; add `OIDC_ISSUER_URL` (required); drop `MOCK_OIDC` from the schema entirely; drop the `MOCK_OIDC=true in production` boot invariant; add `LLMConfigError`-style assertion that `OIDC_ISSUER_URL` is reachable at boot (optional — could be lazy).
5. **`apps/api/src/auth/auth.controller.ts`** — Replace the mock branches + the TODO with a real OIDC code-exchange + id_token validation flow using `jose`. Add `OidcDiscoveryService` (boot-cached discovery doc + JWKS) injected via DI. The session-minting logic + cookie + roles-lookup is preserved.
6. **`apps/api/src/auth/bearer-auth.guard.ts`** — Delete the `MOCK_OIDC` + `X-Mock-User-Id` branch. Cookie + Bearer paths are unchanged.
7. **`apps/api/src/auth/oidc-discovery.service.ts` (new)** — Discovery doc cache, JWKS resolver, id_token verifier (thin wrapper over `jose`'s `jwtVerify` + `createRemoteJWKSet`).
8. **`apps/api/test/unit/cookie-auth.test.ts`, `apps/api/test/e2e/health.e2e.test.ts`, `apps/api/test/e2e/security-headers.e2e.test.ts`** — Replace `MOCK_OIDC=1` setup with a `TEST_AUTH_BYPASS=1` env var; or replace `X-Mock-User-Id` headers with a `mintTestSession(userId)` helper that writes directly to the `sessions` table.
9. **`tests/e2e/fixtures/mock-api.ts`** — Remove `X-Mock-User-Id` from allowed CORS headers; add a Keycloak-login helper that performs the real flow once and caches the cookie. Alternatively, mock-API runs continue using the test-bypass.
10. **`.env.example`** — Replace `ENTRA_*` + `MOCK_OIDC` lines with `OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost`, `OIDC_CLIENT_ID=harvoost-web`, `OIDC_CLIENT_SECRET=...` (or omit for public client).
11. **`infra/bicep/modules/key-vault.bicep`, `infra/bicep/modules/container-app-api.bicep`, `infra/bicep/main.bicep`** — Rename Key Vault secret names from `entra-*` to `oidc-*`; rename `secretRef` mappings in container app definitions. For production, `OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0` becomes a deploy-time string parameter (NOT a secret — issuer URLs are non-sensitive).
12. **`apps/api/src/main.ts`** — Remove the `MOCK_OIDC=${env.MOCK_OIDC}` from the boot log line; add `OIDC_ISSUER_URL=${env.OIDC_ISSUER_URL}` instead.
13. **`packages/shared/src/errors/oidc-failure.ts`** — Tighten the error taxonomy if needed (new codes for `OIDC_DISCOVERY_FAILED`, `OIDC_JWKS_FAILED`, `OIDC_TOKEN_INVALID`, `OIDC_NONCE_MISMATCH`).

Roughly 200-350 LOC backend-dev + a Keycloak realm JSON + a docker-compose change + a Bicep rename pass. The size is comparable to F3 in isolation, but F3 + B3 + dev-ergonomics are all solved together.

### What changes in code

- **Removed:** ~80 LOC of mock-OIDC branches (controller + guard), the `MOCK_OIDC` env var + its boot invariant, the `X-Mock-User-Id` header path.
- **Added:** ~250 LOC for real OIDC discovery + JWKS + id_token verification + code exchange. One new service (`OidcDiscoveryService`).
- **Renamed:** ~5 Key Vault secret names, ~5 env var references.

### What changes in IaC

- **Devops/Bicep:** rename `entra-*` secrets to `oidc-*`. The Entra App Registration step in the operator runbook remains — it's how you get the `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` values for production (you don't get them from "Entra" the product; you get them from your Azure AD app registration, which is just OIDC client provisioning). The runbook should mention that the issuer URL for Entra is `https://login.microsoftonline.com/<tenant-id>/v2.0` and that this URL is non-secret deploy-time config (not a Key Vault entry — environment variable on the container app spec is fine).

### What changes in tests

- Unit/integration tests that asserted `MOCK_OIDC=true in production` boot refusal can be deleted (the env var no longer exists).
- All `X-Mock-User-Id` test helpers migrate to `mintTestSession(userId)` direct-to-DB or `TEST_AUTH_BYPASS` env var (option (a) above).
- E2E specs that mocked the OIDC callback (`POST /v1/auth/oidc/callback` with `{ email, displayName }`) migrate to a real Keycloak login helper (option (b) above). This is the path the user gains the most from — real OIDC exercised end-to-end.
- New tests: OIDC discovery doc caching, JWKS rotation handling, expired-token rejection, audience-mismatch rejection, nonce-mismatch rejection. Roughly 8-12 new test cases.

---

## Alternatives considered

### (a) Keep mock-OIDC + wire real Entra OIDC

This was the original plan implicit in F3. We add the real Entra JWKS validation path; the mock path stays for dev.

**Trade-away:** Doesn't resolve B3 (mock attack surface persists). Doesn't help dev/test ergonomics (the real OIDC code is never exercised in dev — the first prod deploy is the first time we exercise it). Production-realism gap. **Rejected.**

### (b) Strategy pattern with `OIDC_PROVIDER` enum

Add a runtime enum + per-provider implementation classes (`KeycloakOidcStrategy`, `EntraOidcStrategy`, etc.).

**Trade-away:** Over-engineered. OIDC providers are not different "strategies" at the API level — they all speak the same protocol. The IdP-specific bits are exactly `issuer_url`, `client_id`, `client_secret`, and (sometimes) a custom claim-mapping. The first three are env vars. The last is provider-specific quirk that we explicitly chose not to consume (we map roles server-side, not from claims). **Rejected.**

### (c) A different dev IdP (Auth0 dev tier, Authelia, node-oidc-provider, ZITADEL)

- **Auth0 dev tier** — requires internet, requires per-dev signup, can't seed fixture users from a JSON file. Not offline-friendly. Rejected.
- **Authelia** — lightweight but its OIDC IdP support is newer and less battle-tested than Keycloak's. Also harder to seed users via JSON. Rejected.
- **`oidc-provider` (panva/node-oidc-provider)** — Node library, would need a tiny wrapper service. Less batteries-included; no admin UI for inspecting state. Rejected for the small extra integration cost.
- **ZITADEL** — also viable, similar feature set to Keycloak, slightly leaner. Acceptable alternate if Keycloak's memory footprint bothers anyone. Recommended pick is Keycloak because of its longer track record + better realm-import documentation, but **swap is one-line if devops prefers ZITADEL.**

**Chosen: Keycloak.** Most-feature-complete free-tier OIDC IdP with a realm-import-from-JSON format that's easy to seed and committable to the repo.

### (d) No dev IdP at all — replace mock with the `TEST_AUTH_BYPASS` env-var-gated test path only

Skip Keycloak entirely. In dev, `apps/api` accepts a `TEST_AUTH_BYPASS=1` env var that lets the API mint a session directly via a CLI tool. No OIDC handshake in dev.

**Trade-away:** Same problem as (a) — the real OIDC code path is never exercised in dev. F3 stays partial because we don't have a way to exercise the real OIDC handshake locally. **Rejected.** (Though we DO keep `TEST_AUTH_BYPASS` for unit/integration tests because forcing a Keycloak round-trip in 100+ unit tests is needless slowdown.)

---

## Implementation plan (summary for backend-dev + devops)

Backend-dev (in the next pass, P0 priority):
1. Add `jose` dependency to `apps/api`.
2. Write `OidcDiscoveryService` (~80 LOC).
3. Replace `auth.controller.ts` mock branches + TODO with the real OIDC handshake (~150 LOC).
4. Delete `MOCK_OIDC` from env schema, boot invariants, guard, and main.ts log.
5. Add `TEST_AUTH_BYPASS=1` (gated on `NODE_ENV=test`) for test helpers; add `mintTestSession()` helper in `apps/api/test/helpers/session.ts`.
6. Migrate the 50-ish tests using `X-Mock-User-Id` to the new helper. Bulk find-replace.
7. Update `.env.example` and the API README.

Devops (after backend-dev finishes step 3):
1. Add `keycloak` service + `keycloak-realm.json` import to `docker-compose.yml`.
2. Rename Key Vault secrets in Bicep modules (`entra-tenant-id` is REMOVED — the tenant is in the issuer URL; `entra-client-id` → `oidc-client-id`; `entra-client-secret` → `oidc-client-secret`).
3. Add `OIDC_ISSUER_URL` as a deploy-time parameter on the API container app (NOT a Key Vault secret — non-sensitive).
4. Update operator runbook: how to compute the Entra issuer URL, how to do the Entra App Registration (this step is unchanged in process; only the env var names you copy values into change).
5. Update CI workflows to use the new env var names.

Tester / e2e-tester (after devops + backend-dev finish):
1. Replace `X-Mock-User-Id` test helpers with `mintTestSession()` or Keycloak login helpers.
2. Add a Keycloak-readiness wait in `tests/e2e/global-setup.ts` so the e2e suite doesn't race the Keycloak boot.
3. Add the OIDC-specific test cases (audience mismatch, nonce mismatch, expired token, JWKS rotation).

---

## Open questions

1. **Column rename: `users.entra_object_id` → `users.oidc_subject`?**
   - Pros: spec-portable name, matches the actual claim.
   - Cons: requires a DB migration (cheap) + grep-and-replace through ~10 files.
   - **Recommendation:** rename. Defer the call to backend-dev during implementation. Either choice works.

2. **Refresh token handling.**
   - The current architecture says "refresh = re-run OIDC login" (i.e., no long-lived refresh token; on session expiry, the user goes back through the IdP). This is preserved as-is.
   - The OIDC spec emits a `refresh_token` we could persist and use to obtain a fresh `id_token` without user interaction. **Not needed in v1.** Tray + web both run the redirect/device-code flow again on session expiry. Document this in API_NOTES.md.

3. **Does deleting mock-OIDC break the existing ~50 tests that rely on it?**
   - Yes — at the source level. The fix is the `mintTestSession()` helper described in (a) above. Backend-dev should bundle this with the implementation pass so the test suite stays green.
   - The new `TEST_AUTH_BYPASS` env var is a narrower attack surface than `MOCK_OIDC` because it is: (1) gated on `NODE_ENV=test` (not `NODE_ENV!=production`); (2) does NOT expose a public HTTP endpoint that creates sessions from a request body; (3) only invoked via a test helper that writes to the DB directly, not via a route handler. Boot-invariants in `env.ts` will refuse to boot if `TEST_AUTH_BYPASS=1 && NODE_ENV!=test`.

4. **Does this affect the chatbot, Bamboo seam, audit log, or any other module?**
   - No. The change is fully contained in the Auth module + the Bicep secrets. Every other module reads the requester identity from `CurrentUser` and is provider-agnostic by design.

5. **Custom claim mapping (e.g., for org-specific Entra app roles)?**
   - Explicitly out of scope. The IdP returns `sub` + `email`. Roles are owned by Harvoost (`user_roles` table + `admin_email_allowlist`). If a v2 customer needs to push role claims from their IdP, that's a v2 ADR.

---

## References

- ARCHITECTURE.md § Auth (logical component) — Auth module responsibility statement is now provider-agnostic.
- ARCHITECTURE.md § Security architecture — MOCK_OIDC mention is removed by this ADR's r3 revision block.
- ARCHITECTURE.md § Local dev story — dev IdP is now Keycloak, not mock-OIDC.
- ARCHITECTURE.md § Deployment topology — production OIDC issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0` (Entra); env var name changes only.
- STACK.md § Required secrets — Identity/Auth section is now "OIDC (provider-agnostic)".
- TODO_INVENTORY.md § A1 (F3) and § C (B3) — both collapse into this ADR's implementation pass.
