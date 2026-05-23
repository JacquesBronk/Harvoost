// container-app-worker.bicep — Container App for the pg-boss worker.
//
// What/why:
//   Same code base as ca-api, different entrypoint (WORKER_MODE=1, no
//   HTTP). No ingress — workers pull jobs from the pg_boss queue.
//
//   Scale rule v1: simple replica-count rule. KEDA pg-boss scaling
//   (queue-depth aware) is a v1.1 work item — we'd need a custom KEDA
//   scaler config that polls pg_boss.job for active count.
//
// Identity: same shape as the api app — system MI with AcrPull on the
// registry + Key Vault Secrets User on the vault.

param location string
param appName string
param environmentId string
param acrLoginServer string
param acrName string
param imageTag string = 'latest'
param keyVaultName string
param keyVaultUri string

param llmProvider string = 'openai'
param llmModelId string = 'gpt-4o'

param minReplicas int = 1
param maxReplicas int = 3

@description('Container image. Defaults to the same api image (the worker uses the same dist with WORKER_MODE=1).')
param containerImage string = '${acrLoginServer}/harvoost-api:${imageTag}'

resource acrResource 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

resource workerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      // No ingress — worker is internal.
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
      secrets: [
        { name: 'database-url', keyVaultUrl: '${keyVaultUri}secrets/DATABASE-URL', identity: 'system' }
        { name: 'blob-storage-connection-string', keyVaultUrl: '${keyVaultUri}secrets/BLOB-STORAGE-CONNECTION-STRING', identity: 'system' }
        { name: 'appinsights-connection-string', keyVaultUrl: '${keyVaultUri}secrets/APPINSIGHTS-CONNECTION-STRING', identity: 'system' }
        { name: 'openai-api-key', keyVaultUrl: '${keyVaultUri}secrets/OPENAI-API-KEY', identity: 'system' }
        { name: 'acs-email-connection-string', keyVaultUrl: '${keyVaultUri}secrets/ACS-EMAIL-CONNECTION-STRING', identity: 'system' }
        { name: 'acs-email-sender-address', keyVaultUrl: '${keyVaultUri}secrets/ACS-EMAIL-SENDER-ADDRESS', identity: 'system' }
        { name: 'session-secret', keyVaultUrl: '${keyVaultUri}secrets/SESSION-SECRET', identity: 'system' }
        { name: 'audit-hash-secret', keyVaultUrl: '${keyVaultUri}secrets/AUDIT-HASH-SECRET', identity: 'system' }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'WORKER_MODE', value: '1' }
            { name: 'LLM_PROVIDER', value: llmProvider }
            { name: 'LLM_MODEL_ID', value: llmModelId }
            // Worker does not consume OIDC env vars (no HTTP surface, no login flow).
            // ADR-0001 removed MOCK_OIDC entirely; no replacement env var is needed here.
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'BLOB_STORAGE_CONNECTION_STRING', secretRef: 'blob-storage-connection-string' }
            { name: 'APPINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            { name: 'ACS_EMAIL_CONNECTION_STRING', secretRef: 'acs-email-connection-string' }
            { name: 'ACS_EMAIL_SENDER_ADDRESS', secretRef: 'acs-email-sender-address' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'AUDIT_HASH_SECRET', secretRef: 'audit-hash-secret' }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        // v1: no scale rule — minReplicas == 1 keeps the cron jobs alive.
        // v1.1: add a KEDA pg-boss-queue-depth rule via custom metric.
        rules: []
      }
    }
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrResource
  name: guid(acrResource.id, workerApp.id, 'acrpull')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource kvResource 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kvResource
  name: guid(kvResource.id, workerApp.id, 'kv-secrets-user')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output appName string = workerApp.name
output appId string = workerApp.id
output principalId string = workerApp.identity.principalId
