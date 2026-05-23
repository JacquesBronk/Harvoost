// key-vault.bicep — Azure Key Vault for all Harvoost secrets.
//
// What/why:
//   Single secret store. Container Apps reference secrets via secretRef at
//   revision time; the managed identity of each Container App is granted
//   the "Key Vault Secrets User" role (RBAC mode, NOT access policies).
//
//   RBAC mode is the modern default. Access policies are deprecated for
//   new vaults — RBAC integrates cleanly with Entra group membership.
//
// Soft-delete + purge protection:
//   - Soft-delete: always enabled (Azure forces this on new vaults anyway).
//   - Purge protection: enabled for prod (matches the 7-year audit
//     retention promise); disabled for dev so tear-down is cheap.
//
// Secrets to provision after this module deploys (NOT created here — operator
// runs `az keyvault secret set` post-deploy because the values are sensitive
// and may rotate independently of infra):
//
//   OIDC_ISSUER_URL                    (e.g., https://login.microsoftonline.com/<tenant-id>/v2.0)
//   OIDC_CLIENT_ID                     (App Registration "Application (client) ID")
//   OIDC_CLIENT_SECRET                 (App Registration client secret)
//   DATABASE_URL                       (Postgres conn string with sslmode=require)
//   BLOB_STORAGE_CONNECTION_STRING
//   APPINSIGHTS_CONNECTION_STRING
//   OPENAI_API_KEY                     (or the matching key for the chosen LLM_PROVIDER)
//   ACS_EMAIL_CONNECTION_STRING
//   ACS_EMAIL_SENDER_ADDRESS
//   SESSION_SECRET                     (>=32 chars, NOT starting with "dev-")
//   AUDIT_HASH_SECRET                  (>=32 chars, NOT starting with "dev-")
//
// Note: OIDC_ISSUER_URL is technically non-sensitive (it's a public discovery
// URL). It is stored in Key Vault here for two reasons: (1) keeps all
// auth-related config in one place; (2) lets ops rotate the tenant binding
// without redeploying Bicep. The value is treated as a configuration secret
// rather than a true credential.

param location string
param keyVaultName string

@description('Object ID of the Entra group that gets administrative RBAC on this vault.')
param adminGroupObjectId string

param enablePurgeProtection bool = true

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: enablePurgeProtection ? true : null // null lets dev vaults be purged
    publicNetworkAccess: 'Enabled' // GitHub Actions OIDC needs to reach the data plane during deploy
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Role assignment: Key Vault Administrator on the admin group.
// Built-in role ID for "Key Vault Administrator" =
//   00482a5a-887f-4fb3-b363-3b7fe8e74483
resource adminRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, adminGroupObjectId, 'kv-admin')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '00482a5a-887f-4fb3-b363-3b7fe8e74483'
    )
    principalId: adminGroupObjectId
    principalType: 'Group'
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output vaultId string = vault.id
