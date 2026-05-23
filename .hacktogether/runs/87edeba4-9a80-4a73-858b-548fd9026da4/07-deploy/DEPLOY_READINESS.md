# Deploy readiness checklist

Operator: tick every box before running `.github/workflows/deploy.yml` against `prod`.

Source artefacts:
- `infra/bicep/` — the IaC that this checklist gates
- `infra/keycloak/` — the **dev** OIDC IdP (Keycloak) and its seeded realm
- `02-architecture/ADR-0001-oidc-provider-agnostic.md` — the provider-agnostic OIDC decision
- `06-review/HANDOFF.md` — the aggregate review verdict (DEGRADED, V2 unfixed at review time)
- `06-review/HANDOFF_security_review.md` — the 7 must-do devops follow-ups
- `02-architecture/STACK.md` § Required secrets — the env-var contract (r3 names)

## Code/test gates (from review phase)

- [ ] **V2 (audit GUC) addressed**: 15 LOC backend-dev follow-up to wrap `AuditService.record()` in `$transaction` with `SET LOCAL app.audit_hash_secret`. Backend-dev's parallel follow-up pass is implementing this. Confirm `audit_log` rows have non-empty `row_hash` after a smoke insert. *Without this, prod has an empty audit trail.*
- [ ] **V1 (audit integrity HMAC recompute)** — tracked for v1.0.1 (acceptable for v1 deploy; defence-in-depth only).
- [ ] **F3 (real OIDC validation)** — **wired in the follow-up pass via `jose` against any OIDC `OIDC_ISSUER_URL/.well-known/openid-configuration`**. The same code path runs in dev (Keycloak in docker-compose) and prod (Entra ID). Confirm by signing in as `admin@harvoost.local` against the dev Keycloak before any cloud deploy.
- [ ] **B3 (mock-OIDC attack surface)** — **deleted entirely in the follow-up pass.** No `MOCK_OIDC` env var, no `X-Mock-User-Id` header bypass. Confirm by grepping the codebase for `MOCK_OIDC` and finding zero hits.
- [ ] **Major findings deferred to v1.0.1** are explicitly accepted: M2 (LLM error message leak), M3 (chatbot token budget sliding-24h instead of local-day), M4 (`UsersController.getOne` IDOR).
- [ ] No unfixed blocking/critical from review attempt 2/2 beyond those acknowledged above.

## Dev IdP (Keycloak)

Per ADR-0001, the same OIDC code path runs in dev and prod. The dev IdP is Keycloak in docker-compose.

- [ ] `docker compose up -d keycloak` runs; healthcheck reports `healthy`.
- [ ] Admin console at <http://localhost:8080/admin> loads; login with `admin` / `dev-admin-not-for-prod` succeeds.
- [ ] Seeded realm `harvoost` is present with two clients (`harvoost-web` confidential, `harvoost-tray` public+PKCE) and 7 fixture users.
- [ ] `OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost` is set in `.env.local` for local API.
- [ ] First-time sign-in against the dev Keycloak as `admin@harvoost.local` (password `dev-admin-pass`) lands the user in Harvoost with admin role (via `BOOTSTRAP_ADMIN_EMAIL` matching).
- [ ] Seven seeded fixture users + dev passwords are documented in `infra/keycloak/README.md`. **All passwords start with `dev-` so they cannot be mistaken for prod credentials.**

Resetting the dev IdP: `docker compose down keycloak && docker volume rm harvoost-keycloak-data && docker compose up -d keycloak`.

## Infra readiness

- [ ] Resource group provisioned in `southafricanorth` (`rg-harvoost-prod`).
- [ ] **Entra App Registration created in tenant** (still required — Entra is just the production OIDC IdP); the Tenant ID is used only to compute the `OIDC_ISSUER_URL` (it does NOT become its own Key Vault secret).
- [ ] **Application (client) ID + Client Secret captured** → loaded into Key Vault as `OIDC-CLIENT-ID` and `OIDC-CLIENT-SECRET`.
- [ ] **Issuer URL captured** → `https://login.microsoftonline.com/<tenant-id>/v2.0` → loaded into Key Vault as `OIDC-ISSUER-URL`.
- [ ] Federated credential added to the App Registration for GitHub Actions OIDC (`repo:<owner>/Harvoost:ref:refs/heads/main` and `:ref:refs/tags/v*`).
- [ ] Entra admin group object id captured (passed to `adminGroupObjectId` parameter).
- [ ] First bicep deployment ran successfully (`az deployment group create` for `parameters/prod.bicepparam`).
- [ ] Key Vault provisioned **and populated with all required secrets** (see "Secrets in Key Vault" matrix below).
- [ ] Postgres Flexible Server up; admin password rotated; `DATABASE-URL` secret in Key Vault matches.
- [ ] Postgres extensions installed by `prisma migrate deploy` (verified: `\dx` shows `btree_gist`, `pgcrypto`, `citext`).
- [ ] Container Apps Environment up.
- [ ] ACR up; first images pushed (`harvoost-api:<sha>`, `harvoost-web:<sha>`).
- [ ] Application Insights + Log Analytics workspace up; `APPINSIGHTS-CONNECTION-STRING` populated in Key Vault.
- [ ] ACS Email resource up (west europe; cross-region call from worker to ACS accepted).
- [ ] ACS Email sender domain verified (Azure-managed or custom).

## Secrets in Key Vault (matrix — r3 names)

Every row must contain a real value (NOT `__REPLACE_ME__`). The bootstrap process is documented in `infra/bicep/README.md` § First-deploy procedure.

> **(r3 rename)** The legacy `ENTRA-TENANT-ID` / `ENTRA-CLIENT-ID` / `ENTRA-CLIENT-SECRET` secrets are GONE. `OIDC-ISSUER-URL` replaces all three (the tenant id is encoded in the URL). The new client-id/secret names are `OIDC-CLIENT-ID` / `OIDC-CLIENT-SECRET`. If you have a pre-r3 dev/staging vault, run the migration commands at the end of this file.

- [ ] `OIDC-ISSUER-URL` (e.g., `https://login.microsoftonline.com/<tenant-id>/v2.0` for Entra)
- [ ] `OIDC-CLIENT-ID` (App Registration's Application (client) ID)
- [ ] `OIDC-CLIENT-SECRET` (App Registration's client secret)
- [ ] `DATABASE-URL` (Postgres conn string with `sslmode=require`)
- [ ] `BLOB-STORAGE-CONNECTION-STRING`
- [ ] `APPINSIGHTS-CONNECTION-STRING`
- [ ] `OPENAI-API-KEY` (default `LLM_PROVIDER=openai`)
- [ ] `ACS-EMAIL-CONNECTION-STRING`
- [ ] `ACS-EMAIL-SENDER-ADDRESS`
- [ ] `SESSION-SECRET` (>=32 chars, NOT starting with `dev-`; recommend `openssl rand -base64 48`)
- [ ] `AUDIT-HASH-SECRET` (>=32 chars, NOT starting with `dev-`; same recipe)
- [ ] `BOOTSTRAP-ADMIN-EMAIL` set as a Container App env var (not a Key Vault secret — passed via bicepparam)

## First-deploy verifications

- [ ] `GET https://<api-fqdn>/v1/health` returns `200` with `{ status: 'ok', db: { status: 'ok' } }`.
- [ ] Response headers include: `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` set.
- [ ] `GET /v1/auth/oidc/login` returns a 302 redirect to `https://login.microsoftonline.com/<tenant-id>/...` (works once F3 + OIDC env vars are wired and `OIDC_ISSUER_URL` is set correctly).
- [ ] The OIDC discovery doc at `${OIDC_ISSUER_URL}/.well-known/openid-configuration` is reachable from the Container App (run `az containerapp exec -n ca-api-prod --command "wget -qO- ${OIDC_ISSUER_URL}/.well-known/openid-configuration | head -50"`).
- [ ] Container Apps logs show no boot errors (`az containerapp logs show -g <rg> -n ca-api-prod --tail 100`); look for the boot line `oidcIssuer=https://login.microsoftonline.com/...`.
- [ ] Worker container logs show pg-boss successfully boots + the 12 jobs are scheduled.
- [ ] An audit insert succeeds end-to-end (smoke: assign a test admin role and confirm `audit_log` has a new row with non-empty `row_hash`). *This is the V2 check — confirm before declaring deploy successful.*

## Operational

- [ ] App Insights alerts configured (per `infra/bicep/README.md` § Operational alerts).
- [ ] Backup retention verified (Postgres 14 days for prod).
- [ ] Geo-redundant backup configured (paired region: `southafricawest`).
- [ ] On-call rotation defined (out of scope for IaC; mention here so it's not missed).
- [ ] `pnpm audit --prod --audit-level high` passes in the latest CI run.
- [ ] Trivy scan on the deployed image tag has no HIGH/CRITICAL unfixed CVEs.

## Security follow-ups (from security-reviewer HANDOFF)

- [ ] No `MOCK_OIDC` env var in any Container App spec (it was deleted from the schema in the follow-up pass; defence in depth: it should not be defined anywhere).
- [ ] CI smoke test for security headers wired (asserted via Playwright `security-headers.e2e.test.ts`).
- [ ] CVE scan in CI (`pnpm audit --prod` + Trivy) wired — DONE in `.github/workflows/ci.yml`.

## Migration from pre-r3 vaults (if applicable)

If you have an existing Key Vault provisioned BEFORE this ADR landed, run the following migration. The Bicep update above renames the secret references on the Container App, so the OLD names will no longer be consumed — you must populate the NEW names before the next deploy:

```bash
VAULT=<your-vault-name>
TENANT_ID=$(az keyvault secret show --vault-name $VAULT -n ENTRA-TENANT-ID --query value -o tsv)
CLIENT_ID=$(az keyvault secret show --vault-name $VAULT -n ENTRA-CLIENT-ID --query value -o tsv)
CLIENT_SECRET=$(az keyvault secret show --vault-name $VAULT -n ENTRA-CLIENT-SECRET --query value -o tsv)

az keyvault secret set --vault-name $VAULT -n OIDC-ISSUER-URL   --value "https://login.microsoftonline.com/${TENANT_ID}/v2.0"
az keyvault secret set --vault-name $VAULT -n OIDC-CLIENT-ID    --value "$CLIENT_ID"
az keyvault secret set --vault-name $VAULT -n OIDC-CLIENT-SECRET --value "$CLIENT_SECRET"

# Optional cleanup (only after confirming the new names are live):
# az keyvault secret delete --vault-name $VAULT -n ENTRA-TENANT-ID
# az keyvault secret delete --vault-name $VAULT -n ENTRA-CLIENT-ID
# az keyvault secret delete --vault-name $VAULT -n ENTRA-CLIENT-SECRET
```

## Sign-off

| Role | Name | Date | Approved? |
|---|---|---|---|
| devops (deploy operator) |  |  |  |
| security reviewer |  |  |  |
| product owner |  |  |  |
