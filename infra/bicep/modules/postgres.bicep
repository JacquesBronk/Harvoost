// postgres.bicep — Azure Database for PostgreSQL Flexible Server (16.x).
//
// What/why:
//   Single source of truth for app data + pg-boss queue + audit_log.
//
//   Extensions required (per packages/db/prisma/migrations/.../init):
//     - btree_gist  (EXCLUDE constraints on tstzrange + user_id)
//     - pgcrypto    (gen_random_uuid + HMAC for audit_log)
//     - citext      (case-insensitive email)
//
//   These are pre-allowed in azure.extensions server parameter so the
//   init migration's CREATE EXTENSION succeeds without manual portal
//   intervention.
//
// Sizing:
//   - dev:     Standard_B1ms (1 vCPU / 2 GiB) — cheapest viable SKU
//   - prod:    Standard_B2ms (2 vCPU / 4 GiB) — upgrade to GP_D2s_v3 under load
//   - storage: 32 GiB dev / 64 GiB prod (auto-grow enabled)
//
// Backups:
//   - retention: 7 days (dev), 14 days (prod)
//   - geo-redundant: prod yes, dev no
//   - paired region: southafricawest (handled by Azure automatically when
//     geoRedundantBackup=Enabled, since SAN's pair IS SAW)
//
// Auth:
//   For v1 we use native Postgres auth (admin user + password) stored in
//   Key Vault. The Entra-AD auth integration is desirable but adds
//   wiring overhead (granting the Container App MI a Postgres role,
//   getting token-based connections to work through Prisma's libpq).
//   v1.1 work item.
//
// The administrator password is generated at deploy time by the workflow
// (uuidgen + extra entropy) and written to Key Vault before Container
// Apps boot. It is NOT a parameter on this module — the workflow does
// `az postgres flexible-server update --admin-password ...` post-create
// then writes DATABASE_URL to Key Vault as the next step.

param location string
param serverName string

@allowed([
  'Standard_B1ms'
  'Standard_B2ms'
  'Standard_D2s_v3'
])
param skuName string = 'Standard_B1ms'

@minValue(32)
@maxValue(16384)
param storageGB int = 32

@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@allowed([
  'Enabled'
  'Disabled'
])
param geoRedundantBackup string = 'Disabled'

@description('Paired backup region — documentation only; Azure derives the actual replica region from the primary.')
param pairedBackupRegion string = 'southafricawest'

param databaseName string = 'harvoost'
param administratorLogin string = 'harvoost_admin'

@description('Initial administrator password. The deploy workflow ROTATES this immediately after create and writes the rotated value to Key Vault as DATABASE_URL.')
@secure()
param administratorPassword string = newGuid()

// SKU tier derived from name (B-series → Burstable; D-series → GeneralPurpose).
var skuTier = startsWith(skuName, 'Standard_B') ? 'Burstable' : 'GeneralPurpose'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    highAvailability: {
      mode: 'Disabled' // v1 single-AZ; HA = v2 work item
    }
    network: {
      publicNetworkAccess: 'Enabled' // Container Apps egress isn't fixed-IP; firewall rules below restrict access
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled' // v1 = native auth; v1.1 to switch on Entra
      passwordAuth: 'Enabled'
    }
  }
}

// Server parameter: pre-allow the extensions our init migration needs.
resource extensionsParam 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'BTREE_GIST,PGCRYPTO,CITEXT'
    source: 'user-override'
  }
}

// Database.
resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure services (incl. Container Apps egress IPs) to reach the server.
// For tighter prod posture, swap this for a private endpoint + VNet
// integration on the Container Apps Environment. Documented as a v1.1 work
// item in DEPLOY.md.
resource fwAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'allow-azure-services'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output serverName string = server.name
output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = db.name
output administratorLogin string = administratorLogin
output pairedBackupRegionNote string = pairedBackupRegion
