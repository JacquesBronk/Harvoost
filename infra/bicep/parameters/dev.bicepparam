// dev.bicepparam — parameter values for the dev environment.
//
// Sizing: smallest viable SKUs.
//   - Postgres B1ms, LRS storage, 7-day backups, no GRS
//   - Container Apps min replicas 1
//
// Bootstrap admin: dev placeholder; operator must replace with a real address
// before the first prod-like smoke test (the env-validation boot invariant
// in apps/api will refuse to start with admin@harvoost.local).

using '../main.bicep'

param envName = 'dev'
param primaryRegion = 'southafricanorth'
param pairedBackupRegion = 'southafricawest'
param acsEmailRegion = 'westeurope'
param adminGroupObjectId = '00000000-0000-0000-0000-000000000000' // OVERRIDE at deploy
param bootstrapAdminEmail = 'dev-admin@example.com'
param webAppOrigin = 'https://app.dev.harvoost.example.com'
param apiImageTag = 'latest'
param webImageTag = 'latest'
param llmProvider = 'openai'
param llmModelId = 'gpt-4o-mini' // cheap for dev/CI
