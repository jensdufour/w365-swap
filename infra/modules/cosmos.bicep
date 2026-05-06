@description('Cosmos DB SQL account name (globally unique).')
param accountName string

@description('Database name.')
param databaseName string

@description('Location for resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Function App managed identity principalId. When empty, no SQL role assignment is created.')
param principalId string = ''

// Mosaic v0 data model
// - states: one document per saved user-state. PK /userId for tenant-isolated reads.
// - chunks: one document per FastCDC chunk reference (hash, size, container path).
//   PK /userId — chunks are deduped per user since they are encrypted with per-user
//   wrapped DEKs; cross-user dedup is impossible by design.

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2025-04-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      { name: 'EnableServerless' }
    ]
    // RBAC-only data plane. Local primary/secondary keys are disabled.
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
    networkAclBypass: 'AzureServices'
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2025-04-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

resource statesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-04-15' = {
  parent: db
  name: 'states'
  properties: {
    resource: {
      id: 'states'
      partitionKey: {
        paths: [ '/userId' ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
      }
    }
  }
}

resource chunksContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-04-15' = {
  parent: db
  name: 'chunks'
  properties: {
    resource: {
      id: 'chunks'
      partitionKey: {
        paths: [ '/userId' ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
      }
    }
  }
}

// Cosmos DB Built-in Data Contributor (000...002) — full data-plane CRUD on this
// account. Service-defined; not the same as Azure RBAC roles.
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource cosmosDataPlaneRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2025-04-15' = if (!empty(principalId)) {
  parent: cosmos
  name: guid(cosmos.id, principalId, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: principalId
    scope: cosmos.id
  }
}

output accountName string = cosmos.name
output endpoint string = cosmos.properties.documentEndpoint
output databaseName string = db.name
output statesContainerName string = statesContainer.name
output chunksContainerName string = chunksContainer.name
