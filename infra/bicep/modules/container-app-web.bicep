// container-app-web.bicep — Container App for apps/web (Next.js).
//
// What/why:
//   Public-facing Next.js app. Talks to ca-api over HTTPS (via the API's
//   public FQDN). No Key Vault secrets here — the web app is browser-
//   served; any secrets it needs would leak to clients. Build-time public
//   config (NEXT_PUBLIC_API_URL) is the only env var.

param location string
param appName string
param environmentId string
param acrLoginServer string
param acrName string
param imageTag string = 'latest'

@description('Full https URL of the ca-api FQDN. Used as NEXT_PUBLIC_API_URL.')
param apiPublicUrl string

param minReplicas int = 1
param maxReplicas int = 4

param containerImage string = '${acrLoginServer}/harvoost-web:${imageTag}'

resource acrResource 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
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
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'NEXT_PUBLIC_API_URL', value: apiPublicUrl }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 3000
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 3000
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

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrResource
  name: guid(acrResource.id, webApp.id, 'acrpull')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output appName string = webApp.name
output appId string = webApp.id
output fqdn string = webApp.properties.configuration.ingress.fqdn
