@description('Storage account name (globally unique, 3-24 lowercase alphanumeric).')
param accountName string

@description('Container name holding encrypted chunk objects.')
param containerName string = 'chunks'

@description('Location for resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Function App managed identity principalId. When empty, no role assignment is created.')
param principalId string = ''

// Dedicated storage account for encrypted user-state chunks.
// Kept separate from the Function-runtime account so we can apply different
// lifecycle policies, RBAC, and (later) per-customer customer-managed keys.

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    // CDX policy + design choice: identity-only access. Function App's MI
    // generates user-delegation SAS for the agent to upload/download chunks.
    allowSharedKeyAccess: false
    accessTier: 'Hot'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource chunksContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

// Lifecycle: tier chunks to Cool after 30 days idle. ~50% storage cost savings
// for the long tail of states no one is restoring. Hot tier remains for
// recently-accessed chunks (writes and FastCDC dedup hits).
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'tier-cool-30d'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: 30 }
              }
            }
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ containerName ]
            }
          }
        }
      ]
    }
  }
}

// Storage Blob Data Contributor — read/write blob data
resource blobDataContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(storage.id, principalId, 'Storage Blob Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Blob Delegator — required for the MI to call getUserDelegationKey()
// so it can mint user-delegation SAS tokens for the agent.
resource blobDelegatorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(storage.id, principalId, 'Storage Blob Delegator')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output accountName string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output containerName string = chunksContainer.name
