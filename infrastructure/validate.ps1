#Requires -Version 7.0

<#
.SYNOPSIS
    Validates the W365 Swap infrastructure templates without deploying.
#>

$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..' '.env'
if (-not (Test-Path $envFile)) {
    Write-Error "Environment file not found. Copy .env.example to .env and fill in values."
    exit 1
}

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $key = $Matches[1].Trim()
        $value = $Matches[2].Trim().Trim('"')
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

az account set --subscription $env:SUBSCRIPTION_ID
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Validating Bicep templates..." -ForegroundColor Cyan
az deployment group validate `
    --resource-group $env:RESOURCE_GROUP `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters (Join-Path $PSScriptRoot 'main.bicepparam') `
    --output none

if ($LASTEXITCODE -eq 0) {
    Write-Host "Validation passed." -ForegroundColor Green
} else {
    Write-Error "Validation failed."
    exit $LASTEXITCODE
}
