// staging.bicepparam — parameter values for the staging environment.
//
// Mid-tier sizing: prod-like but cheaper. Used as a pre-prod gate for
// migrations + smoke tests against real provider keys.

using '../main.bicep'

param envName = 'staging'
param primaryRegion = 'southafricanorth'
param pairedBackupRegion = 'southafricawest'
param acsEmailRegion = 'westeurope'
param adminGroupObjectId = '00000000-0000-0000-0000-000000000000' // OVERRIDE at deploy
param bootstrapAdminEmail = 'staging-admin@example.com'
param webAppOrigin = 'https://app.staging.harvoost.example.com'
param apiImageTag = 'latest'
param webImageTag = 'latest'
param llmProvider = 'openai'
param llmModelId = 'gpt-4o-mini'
