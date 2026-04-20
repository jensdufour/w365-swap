@description('Name of the storage account for VHD snapshot archival.')
param storageAccountName string

@description('Location for the storage account.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Allow public blob access for snapshot import.')
param allowBlobPublicAccess bool = false

@description('Subnet IDs allowed to access this storage account via service endpoints.')
param allowedSubnetIds array = []

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: allowBlobPublicAccess
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    // Windows 365 Cloud PC snapshot export (Graph createSnapshot with a
    // customer storageAccountId) issues writes from the W365 service, which
    // is NOT covered by the 'AzureServices' bypass list. A 'Deny' default
    // therefore causes the export to silently fail with 'ShareSnapshot: Failed'
    // in Intune, even when RBAC is correct.
    //
    // Data plane remains protected because shared key access is disabled:
    // every caller must present a valid Entra ID token with an appropriate
    // RBAC role on this account. Public network access at the TCP level is
    // not a data-exfil risk under that model.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
      virtualNetworkRules: [for subnetId in allowedSubnetIds: {
        id: subnetId
        action: 'Allow'
      }]
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource snapshotsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'snapshots'
  properties: {
    publicAccess: 'None'
  }
}

resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'archive-old-snapshots'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              // Match both the manually-created 'snapshots' container and the
              // per-tenant containers Windows 365 creates when exporting via
              // Graph createSnapshot (pattern: windows365-share-ent-<suffix>).
              // Without the second prefix, W365-exported VHDs never tier down.
              prefixMatch: [
                'snapshots/'
                'windows365-share-'
              ]
            }
            actions: {
              baseBlob: {
                tierToCool: {
                  daysAfterModificationGreaterThan: 30
                }
                tierToArchive: {
                  daysAfterModificationGreaterThan: 90
                }
              }
            }
          }
        }
      ]
    }
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output primaryBlobEndpoint string = storageAccount.properties.primaryEndpoints.blob
