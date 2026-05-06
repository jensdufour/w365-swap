@description('Name prefix for portal resources.')
param namePrefix string

@description('Location for resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Entra ID tenant ID for authentication.')
param tenantId string

@description('Entra ID app registration client ID.')
param clientId string

@secure()
@description('Entra ID app registration client secret.')
param clientSecret string

@description('Cosmos DB account name (created by cosmos module).')
param cosmosAccountName string

@description('Cosmos DB SQL database name.')
param cosmosDatabaseName string

@description('Cosmos DB document endpoint.')
param cosmosEndpoint string

@description('States storage account name (created by storage-states module).')
param statesStorageAccountName string

@description('States storage container name.')
param statesContainerName string

// Deterministic per-deployment suffix so globally-unique names (KV, Function
// App, Storage) don't collide with other Azure tenants/subscriptions that may
// have squatted the same prefix. Stable per resource group, so re-deploys
// land on the same names.
var uniqueSuffix = take(uniqueString(resourceGroup().id), 6)

var staticWebAppName = '${namePrefix}-portal'
var functionAppName = '${namePrefix}-api-${uniqueSuffix}'
var appServicePlanName = '${namePrefix}-plan'
var keyVaultName = '${namePrefix}-kv-${uniqueSuffix}'
var funcStorageName = toLower(take(replace('stfunc${namePrefix}${uniqueSuffix}', '-', ''), 24))
var deploymentContainerName = 'app-package'

// ---------------------------------------------------------------------------
// Storage Account — dedicated for Function App runtime + Flex deployment
// package. Public network access; data plane protected by Entra-only auth
// (allowSharedKeyAccess: false) + RBAC.
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
    allowSharedKeyAccess: false
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource funcBlobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: funcStorage
  name: 'default'
}

// Container holding the Flex Consumption deployment package(s). The Function
// App's system-assigned identity reads from here on cold start.
resource appPackageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: funcBlobServices
  name: deploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

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
      // Premium is required to host HSM-protected (RSA-HSM) keys, used by
      // the KEK below for envelope encryption of per-state DEKs. Premium
      // is ~$5/month base + per-op fees and supports both software- and
      // HSM-protected keys in the same vault.
      name: 'premium'
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

// Key Encryption Key (KEK) — HSM-protected RSA-4096 used to wrap/unwrap
// per-state Data Encryption Keys (DEKs). The Function App MI never sees
// the raw KEK material; it only calls wrapKey/unwrapKey via the Key Vault
// REST API. Customers can later replace this with a BYOK flow that points
// at their own vault/Managed HSM.
var kekName = 'mosaic-kek'
resource kek 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
  parent: keyVault
  name: kekName
  properties: {
    kty: 'RSA-HSM'
    keySize: 4096
    keyOps: [
      'wrapKey'
      'unwrapKey'
    ]
    attributes: {
      enabled: true
      exportable: false
    }
  }
}

// ---------------------------------------------------------------------------
// Functions App — Flex Consumption (pay-per-execution, scale-to-zero)
// ---------------------------------------------------------------------------

resource appServicePlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${funcStorage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'node'
        version: '20'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    }
    siteConfig: {
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: funcStorage.name }
        // JWT validation needs the tenant and our API's clientId. We use
        // MOSAIC_-prefixed names instead of AZURE_TENANT_ID / AZURE_CLIENT_ID
        // because @azure/identity's DefaultAzureCredential reads those env
        // vars and would attempt to authenticate as the SPA's service
        // principal (EnvironmentCredential) instead of the Function App's
        // managed identity. The collision causes Cosmos/Storage RBAC failures.
        { name: 'MOSAIC_TENANT_ID', value: tenantId }
        { name: 'MOSAIC_API_CLIENT_ID', value: clientId }
        // Required for the Node v4 programming model (app.http(...) in code)
        { name: 'AzureWebJobsFeatureFlags', value: 'EnableWorkerIndexing' }
        // Mosaic v0 — state vault wiring
        { name: 'COSMOS_ACCOUNT_NAME', value: cosmosAccountName }
        { name: 'COSMOS_DATABASE_NAME', value: cosmosDatabaseName }
        { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'STATES_STORAGE_ACCOUNT_NAME', value: statesStorageAccountName }
        { name: 'STATES_CONTAINER_NAME', value: statesContainerName }
        // Mosaic v0 — envelope encryption KEK
        { name: 'KEK_VAULT_URL', value: keyVault.properties.vaultUri }
        { name: 'KEK_KEY_NAME', value: kekName }
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
  dependsOn: [
    appPackageContainer
  ]
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

// Grant the Function App identity Key Vault Crypto User on the vault. This
// allows wrapKey/unwrapKey/encrypt/decrypt/sign/verify on keys but NOT
// key creation, listing, deletion, or purging — the principle of least
// privilege for an envelope-encryption worker. Built-in role id:
// 12338af0-0e69-4776-bea7-57ae8d297424.
resource kvCryptoRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionAppName, 'Key Vault Crypto User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')
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

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output kekName string = kekName
output functionAppResourceId string = functionApp.id
output functionAppPrincipalId string = functionApp.identity.principalId
