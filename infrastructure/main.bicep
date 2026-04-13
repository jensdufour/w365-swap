targetScope = 'resourceGroup'

@description('Name of the storage account for VHD snapshot archival.')
param storageAccountName string

@description('Location for all resources.')
param location string = resourceGroup().location

@description('Tags to apply to all resources.')
param tags object = {
  project: 'w365-swap'
  purpose: 'snapshot-archival'
  'sfi-compliance': 'reviewed'
  'data-classification': 'confidential'
}

module storage 'modules/storageAccount.bicep' = {
  name: 'storageAccount-${uniqueString(resourceGroup().id)}'
  params: {
    storageAccountName: storageAccountName
    location: location
    tags: tags
  }
}

output storageAccountId string = storage.outputs.storageAccountId
output storageAccountName string = storage.outputs.storageAccountName
output primaryBlobEndpoint string = storage.outputs.primaryBlobEndpoint
