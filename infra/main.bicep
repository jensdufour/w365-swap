targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters — azd populates these from environment variables + prompts
// ---------------------------------------------------------------------------

@minLength(1)
@maxLength(64)
@description('Name prefix for all resources (e.g. w365swap).')
param namePrefix string

@minLength(1)
@description('Primary location for all resources.')
param location string

@description('Entra ID tenant ID.')
param tenantId string

@description('Entra ID app registration client ID.')
param clientId string

@secure()
@description('Entra ID app registration client secret.')
param clientSecret string

@description('Tags applied to all resources.')
param tags object = {}

@description('Allowed subnet resource IDs for storage network rules.')
param allowedSubnetIds array = []

@description('Allowed public IP addresses or CIDR ranges for storage access.')
param allowedIpRanges array = []

// ---------------------------------------------------------------------------
// Resource Group
// ---------------------------------------------------------------------------

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${namePrefix}'
  location: location
  tags: union(tags, {
    'azd-env-name': namePrefix
    project: 'w365-swap'
    'sfi-compliance': 'reviewed'
    'data-classification': 'confidential'
  })
}

// ---------------------------------------------------------------------------
// Storage Account — VHD snapshot archival with lifecycle tiering
// ---------------------------------------------------------------------------

module storage 'modules/storage-account.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    storageAccountName: replace('st${namePrefix}', '-', '')
    location: location
    tags: rg.tags
    allowedSubnetIds: allowedSubnetIds
    allowedIpRanges: allowedIpRanges
  }
}

// ---------------------------------------------------------------------------
// Portal — Key Vault, Functions App, Static Web App
// ---------------------------------------------------------------------------

module portal 'modules/portal.bicep' = {
  name: 'portal'
  scope: rg
  params: {
    namePrefix: namePrefix
    location: location
    tags: rg.tags
    storageAccountId: storage.outputs.storageAccountId
    tenantId: tenantId
    clientId: clientId
    clientSecret: clientSecret
  }
}

// ---------------------------------------------------------------------------
// Outputs — consumed by azd and post-provision hook
// ---------------------------------------------------------------------------

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_STORAGE_ACCOUNT_NAME string = storage.outputs.storageAccountName
output AZURE_STORAGE_BLOB_ENDPOINT string = storage.outputs.primaryBlobEndpoint
output AZURE_STORAGE_ACCOUNT_ID string = storage.outputs.storageAccountId
output AZURE_STATIC_WEB_APP_URL string = portal.outputs.staticWebAppUrl
output AZURE_STATIC_WEB_APP_NAME string = portal.outputs.staticWebAppName
output AZURE_FUNCTION_APP_URL string = portal.outputs.functionAppUrl
output AZURE_FUNCTION_APP_NAME string = portal.outputs.functionAppName
output AZURE_KEY_VAULT_NAME string = portal.outputs.keyVaultName
