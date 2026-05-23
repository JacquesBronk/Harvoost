# Deploy plan — Harvoost (IaC authoring, no actual deploy)

## Change

Authored the complete Bicep IaC + GitHub Actions deploy/CI pipelines + the predeploy-readiness checklist for the Harvoost timetracking system. **No actual Azure deployment was performed** — this run is scoped to producing artefacts the operator can review before any real cloud spend.

Deploy target architecture: Azure Container Apps in `southafricanorth` (primary) + `southafricawest` (paired backup), backed by Postgres Flexible Server 16, Azure Blob, Key Vault, Application Insights, ACR, and ACS Email (in `westeurope` as a regional fallback). Entra ID OIDC for auth (App Registration is manual — chicken-and-egg with Key Vault).

## Files touched

### Bicep (all new / overwriting old skeletons)
- `infra/bicep/main.bicep` — top-level orchestrator
- `infra/bicep/modules/log-analytics.bicep` — Log Analytics workspace
- `infra/bicep/modules/app-insights.bicep` — App Insights linked to workspace
- `infra/bicep/modules/key-vault.bicep` — Key Vault (RBAC mode, soft-delete + purge protection)
- `infra/bicep/modules/postgres.bicep` — Postgres Flexible Server 16 with extensions allow-list
- `infra/bicep/modules/blob.bicep` — Storage Account + `exports` container
- `infra/bicep/modules/acr.bicep` — Azure Container Registry (Basic)
- `infra/bicep/modules/acs-email.bicep` — ACS Email (Azure-managed domain)
- `infra/bicep/modules/container-apps-env.bicep` — Container Apps Environment
- `infra/bicep/modules/container-app-api.bicep` — ca-api (public ingress, MI, KV secret refs)
- `infra/bicep/modules/container-app-worker.bicep` — ca-worker (no ingress, WORKER_MODE=1)
- `infra/bicep/modules/container-app-web.bicep` — ca-web (public ingress, Next.js)
- `infra/bicep/parameters/dev.bicepparam`
- `infra/bicep/parameters/staging.bicepparam`
- `infra/bicep/parameters/prod.bicepparam`
- `infra/bicep/README.md` — operator guide (overwrites placeholder)
- Removed old flat scaffolds: `acs-email.bicep`, `app-insights.bicep`, `blob.bicep`, `container-apps.bicep`, `key-vault.bicep`, `postgres.bicep` (all moved into `modules/`)

### CI/CD
- `.github/workflows/ci.yml` — PR + main CI: lint, typecheck, unit tests, Trivy scan, hermetic e2e, bicep build check, pnpm audit
- `.github/workflows/deploy.yml` — env-aware deploy: build/push images → migrate Prisma → bicep what-if + apply → roll Container App revisions → smoke + live e2e

### Container images
- `docker/Dockerfile.api` — multi-stage build for `apps/api` (also serves the worker)
- `docker/Dockerfile.web` — multi-stage build for `apps/web` (Next.js standalone)

### Phase artefacts (this run)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/DEPLOY_PLAN.md` — this file
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/DEPLOY_READINESS.md` — predeploy gate checklist
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/COST_ESTIMATE.md` — per-env monthly cost estimate
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/HANDOFF.md` — phase handoff

## How to test locally

The IaC cannot be exercised end-to-end without a real Azure subscription, but the following local checks validate the artefacts:

```bash
# Syntax check (requires az + bicep installed)
az bicep build --file infra/bicep/main.bicep --stdout > /dev/null
for f in infra/bicep/modules/*.bicep; do
  az bicep build --file "$f" --stdout > /dev/null
done

# Lint the workflow YAML (requires actionlint)
actionlint .github/workflows/ci.yml
actionlint .github/workflows/deploy.yml

# Build container images locally (verifies Dockerfiles)
docker build -f docker/Dockerfile.api -t harvoost-api:local .
docker build -f docker/Dockerfile.web -t harvoost-web:local .
```

`ci.yml` runs the bicep syntax check on every PR (`bicep-validate` job) — that is the canonical CI gate.

## Rollback

**For the IaC itself** (this PR / commit): `git revert` the commit. Nothing is deployed to Azure, so there's nothing to roll back at the cloud layer.

**For when this IaC IS deployed** (future): the per-resource rollback procedures live in `infra/bicep/README.md` § Rollback procedure:
- Container Apps: `az containerapp revision activate` to a prior revision.
- Bicep: re-deploy with the prior commit's main.bicep + parameter file.
- Migrations: case-by-case; rely on the 14-day geo-redundant Postgres backup.

## Dependencies

**New repo-level dependencies (no app code change needed):**
- `actionlint` (optional, dev-only) — workflow linting
- `az` CLI + `bicep` extension (operator's machine) — IaC apply

**Required GitHub repo configuration for deploy.yml to run:**
- Repo secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- Repo variables: `RG_DEV`, `RG_STAGING`, `RG_PROD`, `ADMIN_GROUP_OBJECT_ID`, `BOOTSTRAP_ADMIN_EMAIL_{DEV,STAGING,PROD}`, `WEB_ORIGIN_{DEV,STAGING,PROD}`
- GitHub environments: `dev`, `staging`, `production` (the last with manual approval gate)
- Entra App Registration with a federated credential per branch/tag pattern (one-time manual setup — see DEPLOY_READINESS.md)

**Required Azure resources to pre-provision manually before first deploy:**
- 3x resource groups (one per env)
- Entra App Registration + admin group (capture `Object ID`)

**Key Vault secrets to populate (after first deploy):** see the matrix in `DEPLOY_READINESS.md`.
