using 'main.bicep'

param storageAccountName = readEnvironmentVariable('STORAGE_ACCOUNT_NAME', 'stw365swap')
param location = readEnvironmentVariable('LOCATION', 'westeurope')
