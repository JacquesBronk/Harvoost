// container-app-api.bicep — Container App for apps/api (NestJS).
//
// What/why:
//   The HTTP API surface. PUBLIC ingress (per r2 architecture: tray needs
//   reachability without a private gateway). Bearer auth + strict CORS +
//   throttling are the security layers.
//
// Identity:
//   System-assigned managed identity. Used for:
//     - Pulling images from ACR (AcrPull role)
//     - Reading secrets from Key Vault (Key Vault Secrets User role)
//   Role assignments are created INLINE in this module so the apps work
//   on first apply.
//
// Secrets:
//   Every "secretRef" below maps the container app's local secret name
//   to a Key Vault secret URI. The operator MUST populate the Key Vault
//   secrets BEFORE this module deploys, or the container app revision
//   will fail to activate.
//
// Scaling:
//   HTTP scale rule keyed to concurrent requests. Min/max replicas
//   parameterised per env.

param location string
param appName string
param environmentId string
param acrLoginServer string
param acrName string
param imageTag string = 'latest'
param keyVaultName string
param keyVaultUri string

@description('Web app origin used in CORS_ALLOWED_ORIGINS. Tray does NOT need an entry — see ARCHITECTURE.md § Electron CORS strategy.')
param webAppOrigin string

@description('LLM provider for the chatbot. Default openai.')
param llmProvider string = 'openai'

@description('LLM model id. Default gpt-4o for prod.')
param llmModelId string = 'gpt-4o'

param bootstrapAdminEmail string
param minReplicas int = 1
param maxReplicas int = 5

@description('Container image to deploy. Defaults to a public hello image so first-time apply works before the real image is pushed.')
param containerImage string = '${acrLoginServer}/harvoost-api:${imageTag}'

// ACR pull-role for the managed identity, scoped at the registry resource.
// "AcrPull" role definition id = 7f951dda-4ed3-4680-a7ca-43fe172d538d
resource acrResource 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
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
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        corsPolicy: {
          allowedOrigins: split(webAppOrigin, ',')
          allowedMethods: [
            'GET'
            'POST'
            'PATCH'
            'PUT'
            'DELETE'
            'OPTIONS'
          ]
          allowedHeaders: [
            'authorization'
            'content-type'
            'x-requested-with'
            'idempotency-key'
            'last-event-id'
          ]
          exposeHeaders: [
            'x-request-id'
          ]
          allowCredentials: true
          maxAge: 3600
        }
      }
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
      // Secrets: each Key Vault reference uses the managed identity of
      // this container app. Names below are the container app's LOCAL
      // names (kebab-case). The "value" of each secret in Key Vault is
      // the actual secret material.
      secrets: [
        // OIDC (provider-agnostic — Keycloak in dev, Entra in prod). See ADR-0001.
        { name: 'oidc-issuer-url', keyVaultUrl: '${keyVaultUri}secrets/OIDC-ISSUER-URL', identity: 'system' }
        { name: 'oidc-client-id', keyVaultUrl: '${keyVaultUri}secrets/OIDC-CLIENT-ID', identity: 'system' }
        { name: 'oidc-client-secret', keyVaultUrl: '${keyVaultUri}secrets/OIDC-CLIENT-SECRET', identity: 'system' }
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
          name: 'api'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            // Static
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3001' }
            { name: 'WORKER_MODE', value: '0' }
            { name: 'LLM_PROVIDER', value: llmProvider }
            { name: 'LLM_MODEL_ID', value: llmModelId }
            { name: 'CORS_ALLOWED_ORIGINS', value: webAppOrigin }
            { name: 'BOOTSTRAP_ADMIN_EMAIL', value: bootstrapAdminEmail }
            // From Key Vault — OIDC (provider-agnostic per ADR-0001).
            // In prod, OIDC_ISSUER_URL = https://login.microsoftonline.com/<tenant-id>/v2.0.
            // MOCK_OIDC has been removed entirely; there is only OIDC now, against whatever
            // issuer this env var points to.
            { name: 'OIDC_ISSUER_URL', secretRef: 'oidc-issuer-url' }
            { name: 'OIDC_CLIENT_ID', secretRef: 'oidc-client-id' }
            { name: 'OIDC_CLIENT_SECRET', secretRef: 'oidc-client-secret' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'BLOB_STORAGE_CONNECTION_STRING', secretRef: 'blob-storage-connection-string' }
            { name: 'APPINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            { name: 'ACS_EMAIL_CONNECTION_STRING', secretRef: 'acs-email-connection-string' }
            { name: 'ACS_EMAIL_SENDER_ADDRESS', secretRef: 'acs-email-sender-address' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'AUDIT_HASH_SECRET', secretRef: 'audit-hash-secret' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/v1/health'
                port: 3001
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/v1/health'
                port: 3001
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

// Grant managed identity AcrPull on the registry.
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrResource
  name: guid(acrResource.id, apiApp.id, 'acrpull')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
    principalId: apiApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant managed identity Key Vault Secrets User on the vault.
// "Key Vault Secrets User" role id = 4633458b-17de-408a-b874-0445c86b69e6
resource kvResource 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kvResource
  name: guid(kvResource.id, apiApp.id, 'kv-secrets-user')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
    principalId: apiApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output appName string = apiApp.name
output appId string = apiApp.id
output fqdn string = apiApp.properties.configuration.ingress.fqdn
output principalId string = apiApp.identity.principalId
