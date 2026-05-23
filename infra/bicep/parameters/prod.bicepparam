// prod.bicepparam — parameter values for the production environment.
//
// Sizing: prod SKUs.
//   - Postgres B2ms (auto-grow to D2s_v3 path), GRS, 14-day backups
//   - Container Apps min replicas 2 (HA across instances within a single AZ)
//   - Key Vault purge protection enabled
//   - Blob GRS to southafricawest
//
// Operator MUST set adminGroupObjectId + bootstrapAdminEmail + webAppOrigin
// to real values via CLI override before `az deployment group create`.

using '../main.bicep'

param envName = 'prod'
param primaryRegion = 'southafricanorth'
param pairedBackupRegion = 'southafricawest'
param acsEmailRegion = 'westeurope' // flip to southafricanorth if/when ACS Email reaches SAN GA
param adminGroupObjectId = '00000000-0000-0000-0000-000000000000' // OVERRIDE at deploy
param bootstrapAdminEmail = 'CHANGEME@harvoost.example.com' // OVERRIDE — refused by boot invariant if left as default
param webAppOrigin = 'https://app.harvoost.example.com'
param apiImageTag = 'latest'
param webImageTag = 'latest'
param llmProvider = 'openai'
param llmModelId = 'gpt-4o'
