#Requires -Version 7.0

<#
.SYNOPSIS
    Deploys the W365 Swap storage infrastructure.
.DESCRIPTION
    Validates and deploys the Bicep template for the VHD snapshot storage account.
    Reads configuration from ../.env file.
#>

param(
    [switch]$WhatIf,
    [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..' '.env'
if (-not (Test-Path $envFile)) {
    Write-Error "Environment file not found at $envFile. Copy .env.example to .env and fill in values."
    exit 1
}

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $key = $Matches[1].Trim()
        $value = $Matches[2].Trim().Trim('"')
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

$requiredVars = @('SUBSCRIPTION_ID', 'RESOURCE_GROUP', 'LOCATION', 'STORAGE_ACCOUNT_NAME')
foreach ($var in $requiredVars) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($var))) {
        Write-Error "Required environment variable '$var' is not set in .env"
        exit 1
    }
}

$subscriptionId = $env:SUBSCRIPTION_ID
$resourceGroup = $env:RESOURCE_GROUP
$location = $env:LOCATION

Write-Host "Setting subscription to $subscriptionId" -ForegroundColor Cyan
az account set --subscription $subscriptionId
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$rgExists = az group exists --name $resourceGroup | ConvertFrom-Json
if (-not $rgExists) {
    Write-Host "Creating resource group '$resourceGroup' in '$location'" -ForegroundColor Cyan
    az group create --name $resourceGroup --location $location --output none
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not $SkipValidation) {
    Write-Host "Validating deployment..." -ForegroundColor Cyan
    az deployment group validate `
        --resource-group $resourceGroup `
        --template-file (Join-Path $PSScriptRoot 'main.bicep') `
        --parameters (Join-Path $PSScriptRoot 'main.bicepparam') `
        --output none
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Validation failed."
        exit $LASTEXITCODE
    }
    Write-Host "Validation passed." -ForegroundColor Green
}

if ($WhatIf) {
    Write-Host "Running What-If analysis..." -ForegroundColor Cyan
    az deployment group what-if `
        --resource-group $resourceGroup `
        --template-file (Join-Path $PSScriptRoot 'main.bicep') `
        --parameters (Join-Path $PSScriptRoot 'main.bicepparam')
    exit $LASTEXITCODE
}

Write-Host "Deploying infrastructure..." -ForegroundColor Cyan
$result = az deployment group create `
    --resource-group $resourceGroup `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters (Join-Path $PSScriptRoot 'main.bicepparam') `
    --name "w365swap-$(Get-Date -Format 'yyyyMMdd-HHmmss')" `
    --output json | ConvertFrom-Json

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed."
    exit $LASTEXITCODE
}

Write-Host "`nDeployment succeeded." -ForegroundColor Green
Write-Host "Storage Account: $($result.properties.outputs.storageAccountName.value)"
Write-Host "Blob Endpoint:   $($result.properties.outputs.primaryBlobEndpoint.value)"
