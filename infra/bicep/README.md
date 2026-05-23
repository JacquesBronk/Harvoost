# Harvoost — Azure infrastructure (Bicep)

Authoritative IaC for the Harvoost deployment. All Azure resources are declared here; CI/CD applies them.

**Target region:** `southafricanorth` (primary) + `southafricawest` (paired backup).
**ACS Email region:** `westeurope` (ACS Email is not GA in SAN as of 2026; flip the param when it is).

## Layout

```
infra/bicep/
  main.bicep                   top-level orchestrator (calls modules/)
  modules/
    log-analytics.bicep
    app-insights.bicep
    key-vault.bicep
    postgres.bicep
    blob.bicep
    acr.bicep
    acs-email.bicep
    container-apps-env.bicep
    container-app-api.bicep
    container-app-worker.bicep
    container-app-web.bicep
  parameters/
    dev.bicepparam
    staging.bicepparam
    prod.bicepparam
```

## Resource inventory (per env)

| Resource | Module | Purpose |
|---|---|---|
| Log Analytics workspace | `log-analytics.bicep` | Sink for Container Apps logs + App Insights |
| Application Insights | `app-insights.bicep` | OTel ingestion, traces, dependencies |
| Azure Key Vault | `key-vault.bicep` | All app secrets (RBAC mode, purge protection on prod) |
| Azure Container Registry | `acr.bicep` | Docker images (Basic SKU) |
| Postgres Flexible Server | `postgres.bicep` | App DB + pg-boss queue + audit_log |
| Storage Account + `exports` container | `blob.bicep` | Async XLSX export storage |
| ACS + Email Communication Services | `acs-email.bicep` | Outbound transactional email |
| Container Apps Environment | `container-apps-env.bicep` | Hosting plane |
| ca-api / ca-worker / ca-web | `container-app-*.bicep` | The three running services |

## Estimated monthly cost ranges (USD, rough order of magnitude)

These are ballpark figures using Azure South Africa North pricing where published. **Verify on the Azure pricing calculator before committing — pricing drifts and SA-region values are not always documented.**

| Env | Postgres | Container Apps | Blob | App Insights | ACR | ACS Email | KV | **Total** |
|---|---|---|---|---|---|---|---|---|
| dev | ~$15 (B1ms) | ~$10 (1 replica each, low usage) | <$2 (LRS, small) | ~$5 (low ingest) | $5 (Basic) | <$1 (test sends) | $0 (free tier) | **~$40/mo** |
| staging | ~$30 (B2ms) | ~$25 | ~$3 | ~$10 | $5 | ~$2 | $0 | **~$75/mo** |
| prod | ~$60 (B2ms + GRS) | ~$80 (2+ replicas, scaled) | ~$10 (GRS) | ~$30 | $5 | ~$5 | $0 | **~$190/mo** |

Drivers of variance: chatbot LLM token spend (not in the above — OpenAI billed separately), large XLSX export volume, traffic-driven Container App replica counts.

## First-deploy procedure

1. **Create resource groups (one-time per env):**
   ```bash
   az group create -n rg-harvoost-dev     -l southafricanorth
   az group create -n rg-harvoost-staging -l southafricanorth
   az group create -n rg-harvoost-prod    -l southafricanorth
   ```

2. **Manual Entra ID setup (one-time, NOT in Bicep):**
   Per [ADR-0001](../../.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-oidc-provider-agnostic.md), Harvoost speaks generic OIDC; in production the IdP is Microsoft Entra ID. The Entra App Registration is just the OIDC client-provisioning step.
   - Create an App Registration in Entra (Azure Portal → Entra ID → App registrations → New).
   - Add redirect URIs:
     - `https://app.<env>.harvoost.example.com/v1/auth/callback`
     - `harvoost://auth/callback` (for the Electron tray)
   - Capture:
     - **Tenant ID** (Directory → Properties): you do NOT store this as a Key Vault secret. You use it to build the issuer URL: `OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0`.
     - **Application (client) ID**: goes into Key Vault as `OIDC-CLIENT-ID`.
     - **Client Secret** (Certificates & secrets → New client secret): goes into Key Vault as `OIDC-CLIENT-SECRET`.
   - Create or identify an Entra **group** (e.g., `harvoost-admins`) and capture its `Object ID` — passed to `adminGroupObjectId` param.
   - For GitHub Actions OIDC federation: in the same App Registration, **Federated credentials → Add** → GitHub Actions → repo `<owner>/Harvoost` → branch `main` AND tag `v*`. Repeat for the `production` environment if used.

3. **Bootstrap Key Vault:**
   The full Bicep deployment creates Key Vault but does NOT populate secrets. After the first `az deployment group create` lands the vault, populate secrets via CLI:
   ```bash
   VAULT=$(az keyvault list -g rg-harvoost-dev --query '[0].name' -o tsv)
   TENANT_ID="<entra-tenant-uuid>"
   az keyvault secret set --vault-name $VAULT -n OIDC-ISSUER-URL          --value "https://login.microsoftonline.com/${TENANT_ID}/v2.0"
   az keyvault secret set --vault-name $VAULT -n OIDC-CLIENT-ID           --value "<app-registration-client-id>"
   az keyvault secret set --vault-name $VAULT -n OIDC-CLIENT-SECRET       --value "<app-registration-client-secret>"
   az keyvault secret set --vault-name $VAULT -n DATABASE-URL             --value "postgresql://harvoost_admin:<rotated-pw>@<pg-fqdn>:5432/harvoost?sslmode=require"
   az keyvault secret set --vault-name $VAULT -n BLOB-STORAGE-CONNECTION-STRING --value "<blob-conn-string>"
   az keyvault secret set --vault-name $VAULT -n APPINSIGHTS-CONNECTION-STRING  --value "<from bicep output>"
   az keyvault secret set --vault-name $VAULT -n OPENAI-API-KEY           --value "<openai-key>"
   az keyvault secret set --vault-name $VAULT -n ACS-EMAIL-CONNECTION-STRING --value "<acs-conn-string>"
   az keyvault secret set --vault-name $VAULT -n ACS-EMAIL-SENDER-ADDRESS --value "noreply@<your-domain>"
   az keyvault secret set --vault-name $VAULT -n SESSION-SECRET           --value "$(openssl rand -base64 48)"
   az keyvault secret set --vault-name $VAULT -n AUDIT-HASH-SECRET        --value "$(openssl rand -base64 48)"
   ```

   The OIDC_ISSUER_URL value is non-sensitive (it's a public URL) but we keep it in Key Vault so operators rotate it the same way as any other auth-related setting. If the org swaps from Entra to Auth0/Okta/Keycloak in production, only this one secret changes — there is no Bicep redeploy and no application code change.

4. **Deploy the rest of the infra:**
   ```bash
   az deployment group create \
     -g rg-harvoost-dev \
     --template-file infra/bicep/main.bicep \
     --parameters infra/bicep/parameters/dev.bicepparam \
     --parameters \
       adminGroupObjectId=<entra-group-oid> \
       bootstrapAdminEmail=you@example.com \
       webAppOrigin=https://app.dev.harvoost.example.com
   ```

5. **First image push:**
   - Run `.github/workflows/deploy.yml` manually with `workflow_dispatch` → target_env=dev. The workflow logs into ACR, builds + pushes images, then rolls Container Apps to the new tag.

6. **Run migrations:**
   The deploy workflow does this automatically (`migrate` job before `deploy-apps`). To run manually:
   ```bash
   DATABASE_URL=$(az keyvault secret show --vault-name $VAULT -n DATABASE-URL --query value -o tsv) \
     pnpm db:migrate:deploy
   ```

7. **Verify:**
   - `curl https://<api-fqdn>/v1/health` → expect `200` with `db.status='ok'`.
   - Sign in via the web app — the bootstrap admin gets auto-provisioned on first OIDC login.

## Rollback procedure

**Per Container App revision:**
```bash
# List recent revisions
az containerapp revision list -g rg-harvoost-prod -n ca-api-prod -o table
# Activate a known-good prior revision
az containerapp revision activate -g rg-harvoost-prod -n ca-api-prod --revision <name>
# (optional) deactivate the broken revision
az containerapp revision deactivate -g rg-harvoost-prod -n ca-api-prod --revision <name>
```

**Per Bicep change:** re-deploy with the prior commit's `main.bicep` + parameter file:
```bash
git checkout <prior-sha> -- infra/bicep
az deployment group create -g rg-harvoost-prod --template-file infra/bicep/main.bicep --parameters infra/bicep/parameters/prod.bicepparam
```

**Per migration:** Prisma's forward-only migration model means rollback is case-by-case. Standard playbook:
1. Take a manual Postgres snapshot before the migration: `az postgres flexible-server backup create -g <rg> -n <server>` (geo-redundant for prod auto-backs up every 24h).
2. If the migration breaks prod, restore from the snapshot: `az postgres flexible-server restore ...`.
3. Revert app revisions to the pre-migration image.

There is no auto-rollback for migrations — operator decides per case.

## Operational alerts to configure in Application Insights

The Bicep here does NOT create alert rules (alerts are a layer the operator tunes after baseline traffic is observed). Recommended alerts to wire post-deploy:

| Alert | Threshold | Action group |
|---|---|---|
| `audit.daily_integrity_check` job missed | no successful run in 36h | page on-call |
| Chatbot endpoint p95 latency | > 15s | warn |
| Dashboard endpoint p95 latency | > 1500ms | warn |
| 401 rate spike | > 50/min sustained 5 min | page (brute-force indicator) |
| 429 rate spike | > 100/min sustained 5 min | warn (excess throttling) |
| Overall error rate | > 1% sustained 10 min | page |
| Container App restart | any | warn |
| Postgres CPU | > 80% sustained 10 min | page |
| Postgres storage | > 80% | page (auto-grow may stall) |

Use App Insights' built-in Log alerts (Kusto) for the rate/latency ones and Metric alerts for resource-utilisation ones.

## Validating the bicep before first deploy

```bash
# Syntax check
az bicep build --file infra/bicep/main.bicep --stdout > /dev/null

# Preview against a real resource group (read-only)
az deployment group what-if \
  -g rg-harvoost-dev \
  --template-file infra/bicep/main.bicep \
  --parameters infra/bicep/parameters/dev.bicepparam
```

CI runs the syntax check on every PR (see `.github/workflows/ci.yml`).
