// acs-email.bicep — Azure Communication Services + Email Communication Services.
//
// What/why:
//   Outbound transactional email for weekly summaries + leave notifications.
//
// Region footnote (per ARCHITECTURE.md § Deployment topology):
//   ACS Email's data-plane regional availability is narrower than ACS as
//   a whole. As of 2026, ACS Email is NOT GA in southafricanorth — we
//   default to westeurope. The workload pays ~150–200ms of cross-region
//   latency per email send, which is invisible to end-users (emails are
//   async via the weekly-summary worker).
//
//   If ACS Email reaches SAN GA later, flip `acsEmailRegion=southafricanorth`
//   in the .bicepparam file — no Bicep change needed.
//
// What this module creates:
//   1. ACS resource (data-plane endpoint)
//   2. Email Communication Services resource (domain holder)
//   3. Azure-managed domain (sender uses an `*.azurecomm.net` address by
//      default). For prod you'll likely want to verify a custom domain
//      and update the sender address — that is an operator step
//      post-deploy (Azure portal Add Domain → DNS verification).
//
// Output:
//   The connection string secret name (NOT value). The deploy workflow
//   fetches the connection string with `az communication list-keys` and
//   writes it to Key Vault as ACS-EMAIL-CONNECTION-STRING.

param location string
param acsName string
param emailServiceName string

// ACS resource (global; location must be 'global' for the parent ACS
// resource even when the data location is regional).
resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: acsName
  location: 'global'
  properties: {
    dataLocation: location == 'westeurope' ? 'europe' : 'unitedstates' // tracks dataLocation conventions
  }
}

// Email Communication Services (parent of any custom-verified domain).
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: emailServiceName
  location: 'global'
  properties: {
    dataLocation: location == 'westeurope' ? 'europe' : 'unitedstates'
  }
}

// Azure-managed sender domain (e.g., <random>.azurecomm.net).
// Custom domain verification is a portal step — operator binds it after
// deploy and updates ACS_EMAIL_SENDER_ADDRESS in Key Vault.
resource azureManagedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

output acsResourceName string = acs.name
output emailServiceName string = emailService.name
output azureManagedDomainName string = azureManagedDomain.name
output azureManagedSenderDomain string = azureManagedDomain.properties.mailFromSenderDomain
output connectionStringSecretName string = 'ACS-EMAIL-CONNECTION-STRING'
output senderDomainSecretName string = 'ACS-EMAIL-SENDER-ADDRESS'
