---
phase: deploy (follow-up — Keycloak compose + Bicep secret rename)
agent: devops
started: 2026-05-22T23:40:00Z
finished: 2026-05-22T23:55:00Z
status: complete
---

# Summary

Implemented the docker-compose + IaC side of ADR-0001 (provider-agnostic OIDC). Added a `keycloak` service to `docker-compose.yml` with a seeded `harvoost` realm (`infra/keycloak/realm.json`) containing two clients (`harvoost-web` confidential, `harvoost-tray` public+PKCE) and seven fixture users matching the `packages/db` RBAC seed. Renamed the Bicep Key Vault secrets and Container App env vars from `ENTRA_*` to `OIDC_*` (the three legacy `ENTRA-*` secrets collapse into `OIDC-ISSUER-URL` + `OIDC-CLIENT-ID` + `OIDC-CLIENT-SECRET`; the tenant id is now encoded in the issuer URL). Removed the legacy `MOCK_OIDC=false` env var from both Container Apps. Updated `infra/bicep/README.md` operator bootstrap section + overwrote `07-deploy/DEPLOY_READINESS.md` to reflect the new secrets matrix and the Keycloak dev path.

# Files touched

- `/mnt/c/Projects/Harvoost/docker-compose.yml` (modified) — added `keycloak` service + `keycloak-data` named volume; deleted the legacy "TODO: mock OIDC provider" comment.
- `/mnt/c/Projects/Harvoost/infra/keycloak/realm.json` (new) — Keycloak realm export. `harvoost` realm, `sslRequired: none` (dev only), `registrationAllowed: false`, brute-force protection on, password policy `length(8)`. Two clients (`harvoost-web` confidential with secret `dev-keycloak-client-secret-not-for-prod`, `harvoost-tray` public+PKCE S256). Seven users (admin/alice/finmgr/bob/carol/dave/eve), each with `dev-XXX-pass` password, `enabled=true`, `emailVerified=true`, non-temporary credentials. NO realm-side roles per ADR-0001 (Harvoost owns its role universe).
- `/mnt/c/Projects/Harvoost/infra/keycloak/README.md` (new) — operator guide. Includes admin console URL + creds, OIDC config table the API uses, seeded users with intended Harvoost roles and use cases, realm-reset procedure, and the production note (Keycloak `dev-file` H2 store is not for prod; prod uses Entra).
- `/mnt/c/Projects/Harvoost/infra/bicep/main.bicep` (modified) — updated the top-of-file IdP comment block from `ENTRA_TENANT_ID/CLIENT_ID/CLIENT_SECRET` to `OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET`; noted ADR-0001.
- `/mnt/c/Projects/Harvoost/infra/bicep/modules/key-vault.bicep` (modified) — updated the secrets list comment to list `OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET` instead of `ENTRA_TENANT_ID/CLIENT_ID/CLIENT_SECRET`.
- `/mnt/c/Projects/Harvoost/infra/bicep/modules/container-app-api.bicep` (modified) — renamed the three `entra-*` Key Vault secret references to `oidc-*` (and Vault paths from `ENTRA-*` to `OIDC-*`); renamed the three env vars (`ENTRA_TENANT_ID` removed entirely; `ENTRA_CLIENT_ID` -> `OIDC_CLIENT_ID`; `ENTRA_CLIENT_SECRET` -> `OIDC_CLIENT_SECRET`); added `OIDC_ISSUER_URL` env var (sourced from the `oidc-issuer-url` Key Vault secret); deleted the explicit `MOCK_OIDC=false` env var (the var no longer exists per ADR-0001).
- `/mnt/c/Projects/Harvoost/infra/bicep/modules/container-app-worker.bicep` (modified) — deleted the legacy `MOCK_OIDC=false` env var. Worker does not consume OIDC env vars (no login flow) so no secret rename needed there.
- `/mnt/c/Projects/Harvoost/infra/bicep/README.md` (modified) — rewrote the "Manual Entra ID setup" + "Bootstrap Key Vault" sections to (a) explain Tenant ID is encoded in `OIDC_ISSUER_URL` and is NOT its own secret, (b) list the new `OIDC-ISSUER-URL`/`OIDC-CLIENT-ID`/`OIDC-CLIENT-SECRET` secrets in the CLI bootstrap snippet, (c) note that `OIDC_ISSUER_URL` is technically non-sensitive but kept in Key Vault for ops rotation symmetry.
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/DEPLOY_READINESS.md` (overwritten) — full rewrite. New "Dev IdP (Keycloak)" section. Secrets matrix updated to OIDC-* names. F3 marked "wired via `jose`". B3 marked "deleted entirely". New "Migration from pre-r3 vaults" section with `az keyvault secret set` commands to translate old -> new secret names.
- `/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/HANDOFF.md` (overwritten — this file).

NOT touched (per dispatch boundaries): `apps/**`, `packages/**`, `.github/workflows/**`, `RUN_STATE.md`.

# What downstream agents need to know

- **For backend-dev (running in parallel, OIDC impl + delete-mock):** The dev Keycloak issuer URL is `http://localhost:8080/realms/harvoost`. The web client id is `harvoost-web` with secret `dev-keycloak-client-secret-not-for-prod` (matches the realm export). The tray client id is `harvoost-tray` and it is a **public client with PKCE S256** — there is no secret to ship in the Electron bundle. The Keycloak admin user is `admin` / `dev-admin-not-for-prod`, but the application's BOOTSTRAP_ADMIN_EMAIL should remain `admin@harvoost.local` (the seeded user with password `dev-admin-pass`) — that's the first OIDC login that auto-provisions as Harvoost admin.
- **For backend-dev:** the API's `.env.example` should set `OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost`, `OIDC_CLIENT_ID=harvoost-web`, `OIDC_CLIENT_SECRET=dev-keycloak-client-secret-not-for-prod`, `OIDC_REDIRECT_URI_WEB=http://localhost:3000/v1/auth/callback`, `OIDC_REDIRECT_URI_TRAY=harvoost-dev://auth/callback`. The legacy `ENTRA_*` and `MOCK_OIDC` lines should be deleted.
- **For backend-dev:** the worker container does not need any OIDC env vars (no login flow). I dropped `MOCK_OIDC=false` from the worker Bicep too.
- **For e2e-tester (running in parallel, Keycloak login helper):** Admin console at <http://localhost:8080/admin>. Seeded users + dev passwords listed in `infra/keycloak/README.md`. Direct token endpoint: `http://localhost:8080/realms/harvoost/protocol/openid-connect/token` BUT direct access grants (`grant_type=password`) are **disabled** on the `harvoost-web` client per security best-practice — programmatic e2e login must use the auth-code flow (Playwright drives a real browser login on the Keycloak login page). The `harvoost-tray` client also has direct access grants disabled. If e2e-tester needs a faster path, the recommended pattern is the `mintTestSession(userId)` helper (backend-dev is wiring this) rather than enabling the password grant in the realm.
- **For e2e-tester:** the realm has `bruteForceProtected: true` with `failureFactor: 30`. CI parallel test runs that intentionally fail logins (e.g., wrong-password tests) should keep that under 30 per realm per `maxDeltaTimeSeconds` (12h default) or temporarily reduce `failureFactor` in a CI-specific realm fork. Easier: don't fail-login more than ~5 times in any single run.
- **For docs-writer (later phase):** the operator deploy guide MUST mention the secret rename. I have already updated `infra/bicep/README.md` § "Manual Entra ID setup" + "Bootstrap Key Vault" and added a migration snippet in `DEPLOY_READINESS.md`. Docs-writer should fold the same rename note into any user-facing documentation.
- **Decision note for the orchestrator's run-level decision log:** Chose to STORE `OIDC_ISSUER_URL` in Key Vault rather than as a plain Container App env var. Reasoning: (a) it is auth-related config and operators expect to rotate it via the same flow as the client secret; (b) when an org swaps Entra for Keycloak/Auth0/Okta in production, ZERO Bicep/code changes are needed — just `az keyvault secret set OIDC-ISSUER-URL`. The ADR called it "non-secret deploy-time config" and either choice is valid; this implementation prefers ops symmetry.
- **Container App revision impact:** because the secret names referenced by the API container app have changed, the next `az containerapp update` will create a new revision that depends on `oidc-issuer-url`/`oidc-client-id`/`oidc-client-secret` secrets existing in Key Vault. If those don't exist at update time the revision will fail to activate. Operator MUST run the "Migration from pre-r3 vaults" snippet in `DEPLOY_READINESS.md` BEFORE the next deploy if an old vault is in play. Greenfield vaults are unaffected.

# Open questions / unknowns

- None blocking the parallel lanes. Two notes for record:
  1. The realm export uses `pkce.code.challenge.method: S256` as a CLIENT attribute on both clients. Some Keycloak admins also set it on the realm-level browser-flow as an enforced challenge. I kept it at client-level only because that's what the Keycloak realm-export format publishes by default, and both flows accept S256.
  2. I did NOT add `depends_on: { keycloak: { condition: service_healthy } }` to any apps/api compose entry because the dispatch boundary says don't touch apps/. Backend-dev should add that when they wire the apps/api compose service (or in a separate compose-additions pass).

# Verification evidence

- `Edit` on `docker-compose.yml` succeeded -> keycloak service block + keycloak-data volume present.
- `Write` on `infra/keycloak/realm.json` succeeded -> file written with the realm/clients/users structure as required.
- `Write` on `infra/keycloak/README.md` succeeded.
- `Edit` on `infra/bicep/main.bicep`, `modules/key-vault.bicep`, `modules/container-app-api.bicep`, `modules/container-app-worker.bicep`, `README.md` succeeded.
- `grep -rn -E "ENTRA|MOCK_OIDC|entra-" /mnt/c/Projects/Harvoost/infra/bicep/` -> after edits, the only remaining hits are the deliberate ADR-referencing comments in `container-app-api.bicep`/`container-app-worker.bicep` ("MOCK_OIDC has been removed entirely; ...") — there are zero actual `ENTRA_*` env vars or `entra-*` secret references left in any module. The four `README.md` hits visible during my pre-rewrite grep were eliminated by the subsequent `Edit` to `README.md`.
- Could NOT run `docker compose up keycloak` (no Docker in sandbox) — the first live boot will surface any realm.json schema errors via container logs. The JSON file is well-formed per the `Write` tool and uses the documented Keycloak 25 realm-export structure. JSON-syntax validation via `python3` was blocked by the sandbox; structural correctness verified by visual review against the Keycloak `realm-export.json` schema reference.
- Could NOT run `az bicep build` (no Azure CLI) — Bicep syntax is unchanged from the previously-validated structure; only string literals (secret names, env var names) and one comment block changed. No new constructs introduced.
