#Requires -Version 7.0

function Connect-W365Swap {
    <#
    .SYNOPSIS
        Authenticates to Microsoft Graph and initializes the W365 Swap session.
    .DESCRIPTION
        Acquires a Graph API token using either client credentials (app-only) or
        device code flow (delegated). Initializes the local state file.
    .PARAMETER TenantId
        The Entra ID tenant ID.
    .PARAMETER ClientId
        The app registration client ID.
    .PARAMETER ClientSecret
        The client secret (for app-only auth). Pass as SecureString.
    .PARAMETER DeviceCode
        Use device code flow for delegated authentication.
    .PARAMETER StatePath
        Path to the state file. Defaults to config/state.json in the module root.
    .EXAMPLE
        Connect-W365Swap -TenantId $tenantId -ClientId $clientId -DeviceCode
    .EXAMPLE
        $secret = ConvertTo-SecureString "secret" -AsPlainText -Force
        Connect-W365Swap -TenantId $tenantId -ClientId $clientId -ClientSecret $secret
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$ClientId,

        [Parameter(ParameterSetName = 'ClientCredential')]
        [securestring]$ClientSecret,

        [Parameter(ParameterSetName = 'DeviceCode')]
        [switch]$DeviceCode,

        [string]$StatePath
    )

    $params = @{
        TenantId = $TenantId
        ClientId = $ClientId
    }

    if ($DeviceCode) {
        $params['DeviceCode'] = $true
    }
    elseif ($ClientSecret) {
        $params['ClientSecret'] = $ClientSecret
    }
    else {
        throw 'Specify either -ClientSecret or -DeviceCode for authentication.'
    }

    $token = Get-GraphAccessToken @params
    if (-not $token) {
        throw 'Failed to acquire access token.'
    }

    if (-not $StatePath) {
        $StatePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'config' 'state.json'
    }

    $stateDir = Split-Path $StatePath -Parent
    if (-not (Test-Path $stateDir)) {
        New-Item -Path $stateDir -ItemType Directory -Force | Out-Null
    }

    Initialize-StateFile -Path $StatePath

    Write-Host "Connected to tenant $TenantId. State file: $StatePath" -ForegroundColor Green
}
