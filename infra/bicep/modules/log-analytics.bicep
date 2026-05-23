// log-analytics.bicep — Log Analytics workspace for Container Apps logs +
// Application Insights data plane.
//
// What/why:
//   Container Apps Environment writes its system + console logs to a Log
//   Analytics workspace. Application Insights is workspace-based and points
//   at the same workspace. One workspace per env keeps cross-correlation
//   queries trivial (Kusto JOIN by operation_Id).
//
// Retention:
//   30 days for dev/staging (default Azure pricing tier covers this);
//   90 days for prod (still in the "pay-as-you-go included GB" tier for
//   our expected ingest volume).

param location string
param workspaceName string

@minValue(7)
@maxValue(730)
param retentionDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output customerId string = workspace.properties.customerId
#disable-next-line outputs-should-not-contain-secrets
output primarySharedKey string = workspace.listKeys().primarySharedKey
