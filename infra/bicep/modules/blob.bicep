// blob.bicep — Storage account + `exports` container for async XLSX exports.
//
// What/why:
//   The export worker writes large XLSX files to Blob and emails a 24h
//   pre-signed SAS URL to the requester. The container is PRIVATE — no
//   anonymous access; URLs gate access by SAS signature.
//
//   LRS for dev (cheap); GRS for prod (paired-region replica to
//   southafricawest). Cool/hot tier left at default (hot) — exports are
//   accessed once then forgotten; if cost becomes an issue, lifecycle
//   policies can move them to cool after 1 day. Out of scope v1.
//
// Output:
//   The storage account NAME (not the connection string) is exposed.
//   The deploy workflow fetches the primary key via `az storage account
//   keys list` and writes the assembled connection string into Key Vault
//   as BLOB_STORAGE_CONNECTION_STRING. Doing this in the workflow (not
//   in Bicep) keeps the connection string out of deployment outputs.

param location string
param storageAccountName string

@allowed([
  'Standard_LRS'
  'Standard_GRS'
  'Standard_RAGRS'
  'Standard_ZRS'
])
param skuName string = 'Standard_LRS'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // deploy workflow needs key-based access to build the connection string
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource exportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'exports'
  properties: {
    publicAccess: 'None'
  }
}

output storageAccountName string = storage.name
output storageAccountId string = storage.id
output exportsContainerName string = exportsContainer.name
// Name of the Key Vault secret the deploy workflow MUST create after this
// module deploys. NOT the connection string itself — that is assembled and
// written by the workflow with the runtime account key.
output connectionStringSecretName string = 'BLOB-STORAGE-CONNECTION-STRING'
