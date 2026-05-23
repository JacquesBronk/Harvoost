// main.bicep — Harvoost top-level Azure deployment orchestrator.
//
// What/why:
//   Single entry point that wires all sub-modules under modules/. The deploy
//   workflow runs `az deployment group create` against this file with one of
//   the .bicepparam files under parameters/.
//
// Region strategy (locked in ARCHITECTURE.md § Deployment topology):
//   - Primary region: southafricanorth (Johannesburg)
//   - Paired backup:  southafricawest (Cape Town) — used for Postgres geo-
//     redundant backup and Blob GRS replication.
//   - ACS Email:      defaults to westeurope (ACS Email is not yet GA in
//                     southafricanorth as of 2026); flip the param if/when
//                     SAN comes online.
//
// OIDC IdP note (intentionally NOT created here):
//   Per ADR-0001, identity is provider-agnostic OIDC. In prod the IdP is
//   Microsoft Entra ID; the Entra App Registration is still a one-time
//   manual step. The deploy workflow expects OIDC_ISSUER_URL,
//   OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET to already exist as Key Vault
//   secrets before container apps roll out. The issuer URL for Entra is
//   `https://login.microsoftonline.com/<tenant-id>/v2.0`. See
//   07-deploy/DEPLOY_READINESS.md for the bootstrap sequence.

targetScope = 'resourceGroup'

// ---------- parameters ----------

@description('Environment short-name. Drives SKU sizing and resource naming.')
@allowed([
  'dev'
  'staging'
  'prod'
])
param envName string

@description('Primary Azure region (locked to southafricanorth per architecture).')
@allowed([
  'southafricanorth'
])
param primaryRegion string = 'southafricanorth'

@description('Paired region used as the geo-redundant backup target for Postgres + Blob.')
@allowed([
  'southafricawest'
])
param pairedBackupRegion string = 'southafricawest'

@description('Region for the Azure Communication Services Email resource. Falls back to westeurope when ACS Email is not GA in SAN.')
param acsEmailRegion string = 'westeurope'

@description('Object ID of the Entra group that gets admin RBAC on Key Vault. Provided by the operator at deploy time.')
param adminGroupObjectId string

@description('Bootstrap admin email address — seeded into admin_email_allowlist on first deploy. NEVER admin@harvoost.local in prod.')
param bootstrapAdminEmail string

@description('Public origin of the web app — used by ca-api for CORS_ALLOWED_ORIGINS.')
param webAppOrigin string

@description('Container image tag for ca-api and ca-worker. Defaults to "latest"; deploy workflow overrides with git SHA.')
param apiImageTag string = 'latest'

@description('Container image tag for ca-web.')
param webImageTag string = 'latest'

@description('LLM provider for the chatbot/weekly-summary path. Default openai (per r2 architecture).')
@allowed([
  'openai'
  'anthropic'
  'google'
  'xai'
  'ollama'
])
param llmProvider string = 'openai'

@description('LLM model id. Defaults to gpt-4o for prod, gpt-4o-mini for non-prod via the bicepparam files.')
param llmModelId string = 'gpt-4o'

// ---------- naming convention ----------
// Pattern: <prefix>-harvoost-<env>-<region-short>
// Region short = san for southafricanorth.

var regionShort = 'san'
var namePrefix = 'harvoost-${envName}-${regionShort}'

// ---------- module: Log Analytics + App Insights ----------

module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'logAnalytics'
  params: {
    location: primaryRegion
    workspaceName: 'log-${namePrefix}'
    retentionDays: envName == 'prod' ? 90 : 30
  }
}

module appInsights 'modules/app-insights.bicep' = {
  name: 'appInsights'
  params: {
    location: primaryRegion
    appInsightsName: 'appi-${namePrefix}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
  }
}

// ---------- module: Key Vault ----------

module keyVault 'modules/key-vault.bicep' = {
  name: 'keyVault'
  params: {
    location: primaryRegion
    keyVaultName: 'kv-${namePrefix}'
    adminGroupObjectId: adminGroupObjectId
    enablePurgeProtection: envName == 'prod'
  }
}

// ---------- module: ACR ----------

module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    location: primaryRegion
    acrName: 'acrharvoost${envName}${regionShort}'
    skuName: 'Basic'
  }
}

// ---------- module: Postgres ----------

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: primaryRegion
    serverName: 'pg-${namePrefix}'
    skuName: envName == 'prod' ? 'Standard_B2ms' : 'Standard_B1ms'
    storageGB: envName == 'prod' ? 64 : 32
    backupRetentionDays: envName == 'prod' ? 14 : 7
    geoRedundantBackup: envName == 'prod' ? 'Enabled' : 'Disabled'
    pairedBackupRegion: pairedBackupRegion
    databaseName: 'harvoost'
    administratorLogin: 'harvoost_admin'
  }
}

// ---------- module: Blob Storage ----------

module blob 'modules/blob.bicep' = {
  name: 'blob'
  params: {
    location: primaryRegion
    storageAccountName: 'stharvoost${envName}${regionShort}'
    skuName: envName == 'prod' ? 'Standard_GRS' : 'Standard_LRS'
  }
}

// ---------- module: ACS Email ----------

module acsEmail 'modules/acs-email.bicep' = {
  name: 'acsEmail'
  params: {
    location: acsEmailRegion
    acsName: 'acs-${namePrefix}'
    emailServiceName: 'email-${namePrefix}'
  }
}

// ---------- module: Container Apps Environment ----------

module containerAppsEnv 'modules/container-apps-env.bicep' = {
  name: 'containerAppsEnv'
  params: {
    location: primaryRegion
    environmentName: 'cae-${namePrefix}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
    logAnalyticsCustomerId: logAnalytics.outputs.customerId
    logAnalyticsSharedKey: logAnalytics.outputs.primarySharedKey
  }
}

// ---------- module: Container Apps (api, worker, web) ----------

module apiApp 'modules/container-app-api.bicep' = {
  name: 'apiApp'
  params: {
    location: primaryRegion
    appName: 'ca-api-${envName}'
    environmentId: containerAppsEnv.outputs.environmentId
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageTag: apiImageTag
    keyVaultName: keyVault.outputs.vaultName
    keyVaultUri: keyVault.outputs.vaultUri
    webAppOrigin: webAppOrigin
    llmProvider: llmProvider
    llmModelId: llmModelId
    bootstrapAdminEmail: bootstrapAdminEmail
    minReplicas: envName == 'prod' ? 2 : 1
    maxReplicas: 5
  }
  dependsOn: [
    postgres
    blob
    appInsights
    acsEmail
  ]
}

module workerApp 'modules/container-app-worker.bicep' = {
  name: 'workerApp'
  params: {
    location: primaryRegion
    appName: 'ca-worker-${envName}'
    environmentId: containerAppsEnv.outputs.environmentId
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageTag: apiImageTag
    keyVaultName: keyVault.outputs.vaultName
    keyVaultUri: keyVault.outputs.vaultUri
    llmProvider: llmProvider
    llmModelId: llmModelId
    minReplicas: 1
    maxReplicas: envName == 'prod' ? 3 : 1
  }
  dependsOn: [
    postgres
    blob
    appInsights
    acsEmail
  ]
}

module webApp 'modules/container-app-web.bicep' = {
  name: 'webApp'
  params: {
    location: primaryRegion
    appName: 'ca-web-${envName}'
    environmentId: containerAppsEnv.outputs.environmentId
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageTag: webImageTag
    apiPublicUrl: 'https://${apiApp.outputs.fqdn}'
    minReplicas: envName == 'prod' ? 2 : 1
    maxReplicas: 4
  }
}

// ---------- outputs (consumed by the deploy workflow) ----------

output resourceGroupName string = resourceGroup().name
output primaryRegion string = primaryRegion
output keyVaultName string = keyVault.outputs.vaultName
output keyVaultUri string = keyVault.outputs.vaultUri
output acrLoginServer string = acr.outputs.loginServer
output acrName string = acr.outputs.name
output postgresFqdn string = postgres.outputs.serverFqdn
output postgresDatabaseName string = postgres.outputs.databaseName
output blobAccountName string = blob.outputs.storageAccountName
output appInsightsConnectionString string = appInsights.outputs.connectionString
output containerAppsEnvironmentId string = containerAppsEnv.outputs.environmentId
output apiAppName string = apiApp.outputs.appName
output apiAppFqdn string = apiApp.outputs.fqdn
output workerAppName string = workerApp.outputs.appName
output webAppName string = webApp.outputs.appName
output webAppFqdn string = webApp.outputs.fqdn
