targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters — azd populates these from environment variables + prompts
// ---------------------------------------------------------------------------

@minLength(1)
@maxLength(64)
@description('Name prefix for all resources (e.g. mosaic).')
param namePrefix string

@minLength(1)
@description('Primary location for all resources.')
param location string

@description('Region for Cosmos DB. Empty (default) = same as `location`. Override (e.g. `azd env set AZURE_COSMOS_LOCATION northeurope`) when the primary region is capacity-constrained for Cosmos serverless.')
param cosmosLocation string = ''

@description('Entra ID tenant ID.')
param tenantId string

@description('Entra ID app registration client ID.')
param clientId string

@secure()
@description('Entra ID app registration client secret.')
param clientSecret string

@description('Tags applied to all resources.')
param tags object = {}

// ---------------------------------------------------------------------------
// Resource Group
// ---------------------------------------------------------------------------

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${namePrefix}'
  location: location
  tags: union(tags, {
    'azd-env-name': namePrefix
    project: 'mosaic'
    'sfi-compliance': 'reviewed'
    'data-classification': 'confidential'
  })
}

// Pre-compute deterministic, globally-unique names so we can reference them
// from multiple modules without circular dependencies. Same uniqueString
// derivation used inside portal.bicep so existing Function/KV/funcStorage
// names remain stable across deploys.
var uniqueSuffix = take(uniqueString(rg.id), 6)
var cosmosAccountName = '${namePrefix}-cosmos-${uniqueSuffix}'
var cosmosDatabaseName = 'mosaic'
var cosmosEndpoint = 'https://${cosmosAccountName}.documents.azure.com:443/'
var statesStorageAccountName = take(toLower(replace('ststates${namePrefix}${uniqueSuffix}', '-', '')), 24)
var statesContainerName = 'chunks'

// ---------------------------------------------------------------------------
// Portal — Key Vault, Functions App (Flex Consumption), Static Web App
// ---------------------------------------------------------------------------

module portal 'modules/portal.bicep' = {
  name: 'portal'
  scope: rg
  params: {
    namePrefix: namePrefix
    location: location
    tags: rg.tags
    tenantId: tenantId
    clientId: clientId
    clientSecret: clientSecret
    cosmosAccountName: cosmosAccountName
    cosmosDatabaseName: cosmosDatabaseName
    cosmosEndpoint: cosmosEndpoint
    statesStorageAccountName: statesStorageAccountName
    statesContainerName: statesContainerName
  }
}

// ---------------------------------------------------------------------------
// State vault — Cosmos (metadata) + dedicated Storage (encrypted chunks)
// Both depend on the Function App's managed identity for RBAC.
// ---------------------------------------------------------------------------

module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos'
  scope: rg
  params: {
    accountName: cosmosAccountName
    databaseName: cosmosDatabaseName
    location: empty(cosmosLocation) ? location : cosmosLocation
    tags: rg.tags
    principalId: portal.outputs.functionAppPrincipalId
  }
}

module statesStorage 'modules/storage-states.bicep' = {
  name: 'statesStorage'
  scope: rg
  params: {
    accountName: statesStorageAccountName
    containerName: statesContainerName
    location: location
    tags: rg.tags
    principalId: portal.outputs.functionAppPrincipalId
  }
}

// ---------------------------------------------------------------------------
// Outputs — consumed by azd and post-provision hook
// ---------------------------------------------------------------------------

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_STATIC_WEB_APP_URL string = portal.outputs.staticWebAppUrl
output AZURE_STATIC_WEB_APP_NAME string = portal.outputs.staticWebAppName
output AZURE_FUNCTION_APP_URL string = portal.outputs.functionAppUrl
output AZURE_FUNCTION_APP_NAME string = portal.outputs.functionAppName
output AZURE_KEY_VAULT_NAME string = portal.outputs.keyVaultName
output AZURE_COSMOS_ACCOUNT_NAME string = cosmos.outputs.accountName
output AZURE_COSMOS_DATABASE_NAME string = cosmos.outputs.databaseName
output AZURE_COSMOS_ENDPOINT string = cosmos.outputs.endpoint
output AZURE_STATES_STORAGE_ACCOUNT_NAME string = statesStorage.outputs.accountName
output AZURE_STATES_CONTAINER_NAME string = statesStorage.outputs.containerName
