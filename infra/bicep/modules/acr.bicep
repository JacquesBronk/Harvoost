// acr.bicep — Azure Container Registry (Basic).
//
// What/why:
//   Stores the three Harvoost container images (api, worker, web). Basic
//   tier is sufficient v1 — 10 GiB storage, no geo-replication. Upgrade
//   to Standard/Premium only if image size/pull rate demands it.
//
// Auth:
//   Container Apps pull via the system-assigned managed identity of each
//   app, granted "AcrPull" on this registry. The GitHub Actions deploy
//   workflow pushes via OIDC federation — see deploy.yml.

param location string
param acrName string

@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param skuName string = 'Basic'

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false // we use AAD-only auth via managed identity / OIDC
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
  }
}

output name string = registry.name
output loginServer string = registry.properties.loginServer
output id string = registry.id
