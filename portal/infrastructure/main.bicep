targetScope = 'resourceGroup'

@description('Name prefix for portal resources.')
param namePrefix string = 'w365swap'

@description('Location for resources.')
param location string = resourceGroup().location

@description('Storage account resource ID for VHD archival (from existing infra).')
param storageAccountId string

@description('Entra ID tenant ID for authentication.')
param tenantId string

@description('Entra ID app registration client ID.')
param clientId string

@description('Entra ID app registration client secret.')
@secure()
param clientSecret string

var staticWebAppName = '${namePrefix}-portal'
var functionAppName = '${namePrefix}-api'
var appServicePlanName = '${namePrefix}-plan'
var keyVaultName = '${namePrefix}-kv'

// Key Vault for secure secret storage (SFI requirement: no plaintext secrets in app settings)
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
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
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

resource clientSecretEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-client-secret'
  properties: {
    value: clientSecret
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      appSettings: [
        { name: 'AZURE_TENANT_ID', value: tenantId }
        { name: 'AZURE_CLIENT_ID', value: clientId }
        { name: 'AZURE_CLIENT_SECRET', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=azure-client-secret)' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'STORAGE_ACCOUNT_ID', value: storageAccountId }
      ]
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

// Grant the Function App identity access to Key Vault secrets
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
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

output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output staticWebAppName string = staticWebApp.name
output keyVaultName string = keyVault.name
