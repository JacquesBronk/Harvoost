// app-insights.bicep — Application Insights linked to a Log Analytics workspace.
//
// What/why:
//   Workspace-based App Insights so traces / requests / dependencies / logs
//   all land in the same Kusto store. The connection string is the only
//   piece apps/api needs (OpenTelemetry exporter consumes it via the
//   APPINSIGHTS_CONNECTION_STRING env var).

param location string
param appInsightsName string
param logAnalyticsWorkspaceId string

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output appInsightsName string = appInsights.name
output appInsightsId string = appInsights.id
#disable-next-line outputs-should-not-contain-secrets
output connectionString string = appInsights.properties.ConnectionString
output instrumentationKey string = appInsights.properties.InstrumentationKey
