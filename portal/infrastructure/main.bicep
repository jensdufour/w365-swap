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
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      appSettings: [
        { name: 'AZURE_TENANT_ID', value: tenantId }
        { name: 'AZURE_CLIENT_ID', value: clientId }
        { name: 'AZURE_CLIENT_SECRET', value: clientSecret }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'STORAGE_ACCOUNT_ID', value: storageAccountId }
      ]
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
    }
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
