// container-apps-env.bicep — Azure Container Apps Environment.
//
// What/why:
//   Hosting plane for ca-api, ca-worker, ca-web. Consumption profile only
//   (no dedicated workload profiles in v1) — Azure auto-scales replicas
//   from 0/1 → max based on each app's scale rules.
//
// VNet integration: NOT enabled in v1 (per architecture decision — tray
//   needs public ca-api ingress + CORS + bearer). Adding VNet integration
//   without forcing a redeploy of the env is messy, so we default to no
//   VNet. v1.1 may switch to internal-only with a private gateway.
//
// Logs: shipped to the Log Analytics workspace created by the parent
//   deployment.

param location string
param environmentName string
param logAnalyticsWorkspaceId string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false // single-AZ in v1 (matches Postgres single-AZ)
  }
}

output environmentId string = env.id
output environmentName string = env.name
output defaultDomain string = env.properties.defaultDomain
output staticIp string = env.properties.staticIp
