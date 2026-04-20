@description('Name prefix for portal resources.')
param namePrefix string

@description('Location for resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Storage account resource ID for VHD archival.')
param storageAccountId string

@description('Storage account name for VHD archival (used for RBAC scope).')
param storageAccountName string

@description('Entra ID tenant ID for authentication.')
param tenantId string

@description('Entra ID app registration client ID.')
param clientId string

@secure()
@description('Entra ID app registration client secret.')
param clientSecret string

@description('Subnet ID for Function App VNet integration.')
param integrationSubnetId string

@description('Subnet ID for private endpoints.')
param endpointsSubnetId string

@description('Private DNS zone resource ID for Key Vault.')
param kvDnsZoneId string

var staticWebAppName = '${namePrefix}-portal'
var functionAppName = '${namePrefix}-api'
var appServicePlanName = '${namePrefix}-plan'
var keyVaultName = '${namePrefix}-kv'
var funcStorageName = replace('stfunc${namePrefix}', '-', '')

// ---------------------------------------------------------------------------
// Storage Account — dedicated for Function App runtime (no network restrictions)
// ---------------------------------------------------------------------------

resource funcStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: funcStorageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [
        {
          id: integrationSubnetId
          action: 'Allow'
        }
      ]
    }
  }
}

// Connection string not usable — CDX policy disables shared key access.
// Use managed identity-based AzureWebJobsStorage instead.

// ---------------------------------------------------------------------------
// Key Vault — secure secret storage (SFI: no plaintext secrets in app settings)
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
  }
}

resource clientSecretEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-client-secret'
  properties: {
    value: clientSecret
  }
}

// ---------------------------------------------------------------------------
// Functions App — API backend with managed identity
// ---------------------------------------------------------------------------

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  kind: 'functionapp'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: integrationSubnetId
    vnetRouteAllEnabled: true
    siteConfig: {
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: funcStorage.name }
        { name: 'AZURE_TENANT_ID', value: tenantId }
        { name: 'AZURE_CLIENT_ID', value: clientId }
        { name: 'AZURE_CLIENT_SECRET', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=azure-client-secret)' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'STORAGE_ACCOUNT_ID', value: storageAccountId }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'ENABLE_ORYX_BUILD', value: 'true' }
      ]
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        allowedOrigins: [
          'https://${staticWebAppName}.azurestaticapps.net'
        ]
        supportCredentials: true
      }
    }
  }
}

// Override EasyAuth to AllowAnonymous — SWA linked backend auto-enables EasyAuth
// with RedirectToLoginPage, which blocks parameterised API routes. Our function
// handlers validate Bearer tokens themselves.
// dependsOn linkedBackend so this runs AFTER the linked backend resets auth.
resource functionAppAuth 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  dependsOn: [staticWebAppLinkedBackend]
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
  }
}

// Grant the Function App identity access to Key Vault secrets
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionAppName, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the Function App identity Storage Blob Data Owner on func storage
resource storageBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcStorage.id, functionAppName, 'Storage Blob Data Owner')
  scope: funcStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the Function App identity Storage Queue Data Contributor on func storage
resource storageQueueRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcStorage.id, functionAppName, 'Storage Queue Data Contributor')
  scope: funcStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the Function App identity Storage Table Data Contributor on func storage
resource storageTableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcStorage.id, functionAppName, 'Storage Table Data Contributor')
  scope: funcStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Reference the snapshots storage account to scope an RBAC assignment
resource snapshotsStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Grant the Function App identity Storage Blob Data Contributor on snapshots storage
// Required so the API can list / read / write VHD blobs in the 'snapshots' container.
resource snapshotsBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(snapshotsStorage.id, functionAppName, 'Storage Blob Data Contributor')
  scope: snapshotsStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Static Web App — frontend hosting with linked API backend
// ---------------------------------------------------------------------------

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    buildProperties: {
      appLocation: 'portal/web'
      apiLocation: 'portal/api'
      outputLocation: 'out'
    }
  }
}

resource staticWebAppLinkedBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticWebApp
  name: 'api-backend'
  properties: {
    backendResourceId: functionApp.id
    region: location
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output staticWebAppName string = staticWebApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output functionAppName string = functionApp.name
// ---------------------------------------------------------------------------
// Private Endpoint — Key Vault (works when publicNetworkAccess is Disabled)
// ---------------------------------------------------------------------------

resource kvPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: '${keyVaultName}-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: endpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${keyVaultName}-plsc'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource kvDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: kvPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-vaultcore'
        properties: {
          privateDnsZoneId: kvDnsZoneId
        }
      }
    ]
  }
}

output keyVaultName string = keyVault.name
output functionAppResourceId string = functionApp.id
