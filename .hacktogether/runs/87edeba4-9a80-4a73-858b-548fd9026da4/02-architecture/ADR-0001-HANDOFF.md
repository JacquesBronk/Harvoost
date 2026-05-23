---
phase: architecture (ADR addendum)
agent: architect
started: 2026-05-22T23:15:00Z
finished: 2026-05-22T23:55:00Z
status: complete
---

# Summary

User proposed adopting Keycloak in docker-compose as the dev OIDC IdP and treating Entra as just one OIDC provider — collapsing the three open auth-related findings (F3 real Entra OIDC TODO, B3 mock-OIDC active-debug-code risk, and the dev/test-ergonomics gap) into one implementation. **The architect's formal opinion: ENDORSE with refinements.** OIDC is provider-agnostic by spec; Keycloak is the right dev IdP because it exercises the SAME real-OIDC code path that production runs against Entra. No strategy pattern is needed — `OIDC_ISSUER_URL` IS the strategy. The mock-OIDC mode + `X-Mock-User-Id` header bypass should be deleted entirely (resolves B3); `ENTRA_*` env vars rename to `OIDC_*`; one `jose`-based id_token validator works for any compliant IdP. Tests migrate from `MOCK_OIDC=1` + header-based bypass to a `TEST_AUTH_BYPASS=1` + `mintTestSession()` helper (narrower attack surface) for unit/integration, and to a real Keycloak login helper for E2E. The full decision record is `ADR-0001-oidc-provider-agnostic.md`; ARCHITECTURE.md and STACK.md have been updated with an r3 revision block and renamed secret table respectively.

# Files touched

- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-oidc-provider-agnostic.md` (new) — full ADR (~250 lines, decision + alternatives + consequences + file-by-file implementation plan).
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ARCHITECTURE.md` (modified) — r3 entry in revision history; § Auth logical component generalised; § Security architecture's new "Auth (r3)" subsection; § Local dev story updated (Keycloak in compose, no mock-OIDC); § Deployment topology (External OIDC IdP, Key Vault secret rename, first-deploy bootstrap step); new Risk #20 (dev/prod IdP drift); downstream-agent notes for r3 added; r3 revision request block at the bottom.
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/STACK.md` (modified) — r3 entry in header; § Identity/Auth section renamed to "OIDC (provider-agnostic)"; old `ENTRA_*` / `MOCK_OIDC` rows shown as struck-through with rename notes; `jose` added to backend libraries; Keycloak added to local-infra services; § Local-dev secrets summary updated; new deviations row for r3.
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-HANDOFF.md` (new) — this file.

# What downstream agents need to know

- **Decision for the run's Decision log:** Architect endorses the user's proposal. Auth becomes provider-agnostic OIDC; mock-OIDC is deleted; Keycloak is the dev IdP. Env vars rename `ENTRA_*` → `OIDC_*`; new `OIDC_ISSUER_URL`. F3 + B3 + dev-ergonomics gap collapse into one implementation pass. Pending HITL acknowledgement at the predeploy gate.

- **For backend-dev (P0 in the next focused pass):**
  - Add `jose` (5.x) to `apps/api`.
  - Replace `apps/api/src/auth/auth.controller.ts` mock branches + TODO with a real OIDC implementation: `OidcDiscoveryService` (boot-cached discovery doc + JWKS via `createRemoteJWKSet`), code-exchange against the discovered `token_endpoint`, id_token validation via `jwtVerify` (signature, `iss`, `aud === OIDC_CLIENT_ID`, `exp`, `nbf`, `nonce`).
  - Canonical user identifier = `sub` claim. Email is secondary (for `admin_email_allowlist` lookup only). DO NOT consume role claims from the IdP.
  - Delete `MOCK_OIDC` from `apps/api/src/config/env.ts` (including the boot invariant). Delete the `X-Mock-User-Id` branch in `apps/api/src/auth/bearer-auth.guard.ts`. Cookie + bearer auth paths are preserved.
  - Add a `TEST_AUTH_BYPASS=1` env var gated on `NODE_ENV=test` for the new `mintTestSession(userId)` test helper. Boot-invariants must refuse `TEST_AUTH_BYPASS=1 && NODE_ENV!=test`.
  - Migrate ~50 existing tests using `X-Mock-User-Id` to the new helper. Affected files: `apps/api/test/unit/cookie-auth.test.ts`, `apps/api/test/unit/env-validation.test.ts`, `apps/api/test/e2e/security-headers.e2e.test.ts`, `apps/api/test/e2e/health.e2e.test.ts`, and any others under `apps/api/test/`.
  - Optional column rename: `users.entra_object_id` → `users.oidc_subject` (semantically the OIDC `sub`). Backend-dev's call. If renamed, update the migration + unique index name. The fallback email lookup handles the silent migration of any rows populated under the old mock path (e.g., `mock-${email}`).
  - File-by-file plan in ADR-0001 § Implementation plan and ARCHITECTURE.md § What downstream agents need to know.

- **For devops:**
  - Update Bicep modules to use OIDC_* secret names:
    - `entra-tenant-id` REMOVED (the tenant is encoded in the issuer URL).
    - `entra-client-id` → `oidc-client-id`.
    - `entra-client-secret` → `oidc-client-secret`.
    - `OIDC_ISSUER_URL` is a non-secret deploy-time environment variable on the container app (NOT a Key Vault entry — issuer URLs are non-sensitive).
  - Production `OIDC_ISSUER_URL` for Entra = `https://login.microsoftonline.com/<tenant-id>/v2.0`.
  - The Entra App Registration step in the operator runbook remains — it's just how you get the `oidc-client-id` + `oidc-client-secret` values for prod. The runbook should be generalised to "register the relying party at your OIDC IdP" with Entra-specific instructions as the worked example.
  - Add `keycloak` service to `docker-compose.yml` (image `quay.io/keycloak/keycloak:25`, port `127.0.0.1:8080:8080`, command `start-dev --import-realm`, volume mount the realm export, healthcheck on `/health/ready`). DO NOT touch `docker-compose.yml` yet — devops own this file; the ADR documents the change.
  - Add `infra/keycloak/harvoost-realm.json` with the seeded realm (Alice/Bob/Carol/Dave fixture users matching `packages/db/prisma/seed.ts`).
  - Update GitHub Actions workflows (`.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/e2e.yml`) for the renamed env vars.

- **For tester / e2e-tester:**
  - Replace `X-Mock-User-Id` test helpers with `mintTestSession(userId)` for unit/integration tests.
  - For E2E (`tests/e2e/specs/auth.spec.ts` and any spec that needs a logged-in user), add a Playwright helper that performs the real Keycloak authorization-code flow once per worker, captures the session cookie, and reuses it.
  - Add OIDC validation test cases: audience mismatch (rejected), nonce mismatch (rejected), expired token (rejected), JWKS rotation (signature failure triggers re-fetch), unknown issuer (rejected). Roughly 8-12 new tests.
  - Remove the `MOCK_OIDC=1` setup from `process.env` mutations at test boot (no longer applies). Use `TEST_AUTH_BYPASS=1` + `NODE_ENV=test` instead.

- **For database-admin (only if backend-dev opts to rename the column):**
  - Add a migration `20260523_NNNNNN_rename_entra_object_id_to_oidc_subject` that renames `users.entra_object_id` to `users.oidc_subject` and renames the unique index correspondingly. This is optional — see ADR-0001 § Open questions.

- **For orchestrator's Decision log (append):**
  - 2026-05-22T23:55:00Z — Architect ADR-0001 issued: auth becomes OIDC (provider-agnostic; Entra in prod, Keycloak in dev). `MOCK_OIDC` + `X-Mock-User-Id` deleted. `ENTRA_*` env vars renamed to `OIDC_*`; new `OIDC_ISSUER_URL`. Resolves F3 + B3 + dev/test-ergonomics gap in one backend-dev pass. Pending HITL acknowledgement at predeploy gate.

# Open questions / unknowns

- **Column rename: `users.entra_object_id` → `users.oidc_subject`?** Backend-dev's call. Both work. ADR-0001 § Open questions covers both paths.
- **HITL acknowledgement:** This ADR is "Proposed" status. The user surfaced this as a proposal; the orchestrator should relay this HANDOFF + the ADR back to the user for explicit go/no-go before dispatching backend-dev to implement.
- **Backward-compat dual-naming?** Some teams keep the old env var names as fallbacks for one release. I have NOT included that — the change is contained enough (only `apps/api/src/config/env.ts` + Bicep + `.env.example`) that a single-shot rename is cleaner. If backend-dev disagrees, ADD a transitional period (accept both `ENTRA_*` and `OIDC_*` for one release, log a deprecation warning).

# Verification evidence

- Read `apps/api/src/auth/auth.controller.ts` (200 LOC) — confirmed F3 TODO at lines 50-55 (real Entra OIDC unimplemented) and mock-OIDC branches at 44-55, 69-82, 84-159. The session-minting + cookie + roles-lookup machinery is fully built and provider-agnostic — only the id_token validation step is missing.
- Read `apps/api/src/auth/bearer-auth.guard.ts` (113 LOC) — confirmed the `X-Mock-User-Id` bypass at lines 35-51 and that cookie + bearer auth paths are preserved cleanly.
- Read `apps/api/src/config/env.ts` (88 LOC) — confirmed `MOCK_OIDC` schema + boot invariant + `ENTRA_*` optionals. Schema is straightforward to rename.
- Grep'd for `MOCK_OIDC` / `X-Mock-User-Id` / `ENTRA_` across the repo (19 files matched). Spread: `.github/workflows/*` (3), `infra/bicep/*` (3), `apps/api/src/*` + `apps/api/test/*` (10), `tests/e2e/fixtures/mock-api.ts` (1), `docker-compose.yml` (1), `.env.example` (1), `turbo.json` (1). All within the scope documented in the ADR § Implementation plan.
- Read `docker-compose.yml` (102 LOC) — confirmed there's a TODO comment at line 88-93 explicitly anticipating a mock-OIDC container; the r3 decision REPLACES that anticipated mock with a real Keycloak. The compose's `depends_on` chain already supports adding a Keycloak service with healthcheck-gating.
- Read existing `02-architecture/ARCHITECTURE.md` (1656 lines pre-r3) and `02-architecture/STACK.md` (240 lines pre-r3) — confirmed the r0/r1/r2 revision-block pattern; r3 follows the same shape.
- Cross-referenced TODO_INVENTORY.md § A1 (F3) and § C (B3) — both findings are explicitly addressed by this ADR's implementation pass and recommended for closure once the pass lands.
- Consistency check against RBAC + role-mapping invariants: the proposed change does NOT consume role claims from the IdP — Harvoost's role authority (`user_roles` + `admin_email_allowlist`) is preserved unchanged. The cascade-visibility / RbacScopeService / chatbot-RBAC invariants are untouched.
- Consistency check against the 26-table data model: no new tables; `users.entra_object_id` is the only column with a provider-named identifier and the ADR documents the optional rename. No schema-level coupling to Entra remains after r3.
