@description('Name prefix for networking resources.')
param namePrefix string

@description('Location for resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

var vnetName = '${namePrefix}-vnet'
var vnetAddressPrefix = '10.0.0.0/16'
var integrationSubnetName = 'snet-integration'
var integrationSubnetPrefix = '10.0.1.0/24'
var endpointsSubnetName = 'snet-endpoints'
var endpointsSubnetPrefix = '10.0.2.0/24'

// ---------------------------------------------------------------------------
// Virtual Network
// ---------------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        name: integrationSubnetName
        properties: {
          addressPrefix: integrationSubnetPrefix
          delegations: [
            {
              name: 'delegation-webapp'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
          serviceEndpoints: [
            { service: 'Microsoft.Storage' }
          ]
        }
      }
      {
        name: endpointsSubnetName
        properties: {
          addressPrefix: endpointsSubnetPrefix
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Private DNS Zone — Key Vault
// ---------------------------------------------------------------------------

resource kvDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}

resource kvDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: kvDnsZone
  name: '${vnetName}-kv-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnet.id
    }
    registrationEnabled: false
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output vnetId string = vnet.id
output integrationSubnetId string = vnet.properties.subnets[0].id
output endpointsSubnetId string = vnet.properties.subnets[1].id
output kvDnsZoneId string = kvDnsZone.id
