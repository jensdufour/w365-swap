#Requires -Version 7.0

<#
.SYNOPSIS
    Pre-provision hook: creates or updates the Entra ID app registration.
.DESCRIPTION
    Runs before azd provision. Creates the app registration, configures SPA platform,
    exposes API scope, assigns Graph permissions, and creates a client secret.
    Stores results in azd environment variables for Bicep consumption.
    Idempotent — safe to run multiple times.
#>

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-AzdEnv([string]$Key) {
    $val = azd env get-value $Key 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $val
}

function Set-AzdEnv([string]$Key, [string]$Value) {
    azd env set $Key $Value
    if ($LASTEXITCODE -ne 0) { throw "Failed to set azd env variable '$Key'" }
}

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------

$null = az account show 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged into Azure CLI — running 'az login'..." -ForegroundColor Yellow
    az login --output none
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI login failed." }
}

$envName = Get-AzdEnv 'AZURE_ENV_NAME'
if (-not $envName) { throw "AZURE_ENV_NAME not set. Run 'azd env new' first." }

$tenantId = (az account show --query tenantId -o tsv)
Set-AzdEnv 'AZURE_TENANT_ID' $tenantId

Write-Host "`n=== Mosaic — Entra ID App Registration ===" -ForegroundColor Cyan

$appDisplayName = "Mosaic ($envName)"

# ---------------------------------------------------------------------------
# Create or locate existing app registration
# ---------------------------------------------------------------------------

$existingClientId = Get-AzdEnv 'AZURE_CLIENT_ID'

if ($existingClientId) {
    $app = az ad app show --id $existingClientId 2>$null | ConvertFrom-Json
    if ($app) {
        Write-Host "Using existing app registration: $($app.displayName) ($existingClientId)" -ForegroundColor Green
    } else {
        Write-Host "Stored client ID '$existingClientId' not found — creating new app." -ForegroundColor Yellow
        $existingClientId = $null
    }
}

if (-not $existingClientId) {
    # Check if an app with this display name already exists
    $existing = az ad app list --display-name $appDisplayName --query "[0]" 2>$null | ConvertFrom-Json
    if ($existing) {
        Write-Host "Found existing app '$appDisplayName' — reusing." -ForegroundColor Green
        $existingClientId = $existing.appId
        Set-AzdEnv 'AZURE_CLIENT_ID' $existingClientId
    } else {
        Write-Host "Creating app registration '$appDisplayName'..." -ForegroundColor Cyan
        $newApp = az ad app create `
            --display-name $appDisplayName `
            --sign-in-audience AzureADMyOrg `
            --output json | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw "Failed to create app registration." }

        $existingClientId = $newApp.appId
        Set-AzdEnv 'AZURE_CLIENT_ID' $existingClientId
        Write-Host "Created app registration: $existingClientId" -ForegroundColor Green

        # Brief pause for Entra ID propagation
        Write-Host "Waiting for Entra ID propagation..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
}

$clientId = $existingClientId

# ---------------------------------------------------------------------------
# Ensure service principal exists
# ---------------------------------------------------------------------------

$sp = az ad sp show --id $clientId 2>$null | ConvertFrom-Json
if (-not $sp) {
    Write-Host "Creating service principal..." -ForegroundColor Cyan
    az ad sp create --id $clientId --output none
    if ($LASTEXITCODE -ne 0) { throw "Failed to create service principal." }
    Start-Sleep -Seconds 3
}

# ---------------------------------------------------------------------------
# Configure SPA platform with redirect URIs
# ---------------------------------------------------------------------------

Write-Host "Configuring SPA platform..." -ForegroundColor Cyan

$appManifest = az ad app show --id $clientId --output json | ConvertFrom-Json

# Merge strategy: keep whatever is already on the app registration, then
# union in (a) localhost for dev, (b) the SWA URL if known, and (c) any
# custom domains the user persisted in azd env via AZURE_EXTRA_REDIRECT_URIS
# (semicolon-separated). This means manually-added URIs (e.g. custom domains
# added in the Azure Portal) survive `azd up` re-runs.
$redirectUris = [System.Collections.Generic.List[string]]::new()
foreach ($u in @($appManifest.spa.redirectUris)) {
    if ($u) { [void]$redirectUris.Add($u) }
}

if ('http://localhost:3000' -notin $redirectUris) { [void]$redirectUris.Add('http://localhost:3000') }

$existingSwaUrl = Get-AzdEnv 'AZURE_STATIC_WEB_APP_URL'
if ($existingSwaUrl -and $existingSwaUrl -notin $redirectUris) {
    [void]$redirectUris.Add($existingSwaUrl)
}

$extraUris = Get-AzdEnv 'AZURE_EXTRA_REDIRECT_URIS'
if ($extraUris) {
    foreach ($u in ($extraUris -split '[;,]')) {
        $u = $u.Trim()
        if ($u -and $u -notin $redirectUris) { [void]$redirectUris.Add($u) }
    }
}

$spaBody = @{
    spa = @{
        redirectUris = @($redirectUris)
    }
} | ConvertTo-Json -Depth 3

$tempFile = [System.IO.Path]::GetTempFileName()
$spaBody | Set-Content $tempFile -Encoding utf8
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$($appManifest.id)" --body "@$tempFile" --headers "Content-Type=application/json" --output none
$spaResult = $LASTEXITCODE
Remove-Item $tempFile -ErrorAction SilentlyContinue
if ($spaResult -ne 0) { Write-Warning "Failed to set SPA redirect URIs — update manually." }
else { Write-Host "SPA redirect URIs configured ($($redirectUris.Count))." -ForegroundColor Green }

# ---------------------------------------------------------------------------
# Expose API scope (for OBO flow)
# ---------------------------------------------------------------------------

Write-Host "Configuring exposed API scope..." -ForegroundColor Cyan

$apiUri = "api://$clientId"

# Set Application ID URI
az ad app update --id $clientId --identifier-uris $apiUri --output none 2>$null

# Pre-authorized applications: client apps that can request our exposed scope
# without a user consent prompt. Includes Azure CLI (for `az account
# get-access-token` smoke tests + CI) and the SPA itself (the SPA's clientId
# is the same as ours, since it's a single-app design — but we still list it
# explicitly for clarity in the manifest).
$cliClientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'   # Microsoft Azure CLI
$preAuthorizedClients = @($cliClientId, $clientId) | Sort-Object -Unique

# Re-fetch latest manifest
$appManifest = az ad app show --id $clientId --output json | ConvertFrom-Json
$existingScope = $appManifest.api.oauth2PermissionScopes | Where-Object { $_.value -eq 'access_as_user' }

# Determine scope id (reuse existing, otherwise mint a new one)
$scopeId = if ($existingScope) { $existingScope.id } else { [guid]::NewGuid().ToString() }

# Build the full api block. Note: PATCH on `api` is a full replace, so we
# must include scopes + preAuthorizedApplications + requestedAccessTokenVersion
# together. requestedAccessTokenVersion=2 is required because lib/auth.ts
# validates the v2 issuer (login.microsoftonline.com/{tid}/v2.0).
$apiBlock = @{
    requestedAccessTokenVersion = 2
    oauth2PermissionScopes      = @(
        @{
            id                      = $scopeId
            adminConsentDescription = 'Access the Mosaic API on behalf of the signed-in user'
            adminConsentDisplayName = 'Access Mosaic API'
            isEnabled               = $true
            type                    = 'User'
            userConsentDescription  = 'Access the Mosaic API on your behalf'
            userConsentDisplayName  = 'Access Mosaic API'
            value                   = 'access_as_user'
        }
    )
    preAuthorizedApplications   = @(
        foreach ($appId in $preAuthorizedClients) {
            @{
                appId         = $appId
                delegatedPermissionIds = @($scopeId)
            }
        }
    )
}

$apiBody = @{ api = $apiBlock } | ConvertTo-Json -Depth 6

$tempFile = [System.IO.Path]::GetTempFileName()
$apiBody | Set-Content $tempFile -Encoding utf8
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$($appManifest.id)" --body "@$tempFile" --headers "Content-Type=application/json" --output none
$apiResult = $LASTEXITCODE
Remove-Item $tempFile -ErrorAction SilentlyContinue
if ($apiResult -ne 0) {
    Write-Warning "Failed to update API config — configure manually (v2 tokens + preauth)."
} else {
    Write-Host "API scope configured: $apiUri/access_as_user (v2 tokens, $($preAuthorizedClients.Count) preauthorized clients)." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Add Graph API permissions (delegated)
# ---------------------------------------------------------------------------

Write-Host "Configuring API permissions..." -ForegroundColor Cyan

# Microsoft Graph App ID
$graphAppId = '00000003-0000-0000-c000-000000000000'

# Permission IDs (well-known):
#   User.Read = e1fe6dd8-ba31-4d61-89e7-88639da4683d
#
# Mosaic's API does not call Graph for Cloud PC management; the agent uses
# native broker auth and the API only validates JWTs. Only User.Read is
# required so the portal can show the signed-in user's name.

$requiredPermissions = @(
    @{ id = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'; type = 'Scope' }  # User.Read
)

foreach ($perm in $requiredPermissions) {
    az ad app permission add --id $clientId --api $graphAppId --api-permissions "$($perm.id)=$($perm.type)" --output none 2>$null
}

# Attempt admin consent (will fail silently if user lacks admin role)
Write-Host "Attempting admin consent..." -ForegroundColor Cyan
az ad app permission admin-consent --id $clientId --output none 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Admin consent granted." -ForegroundColor Green
} else {
    Write-Warning @"
Could not grant admin consent automatically.
Ask a Global Admin to grant consent in the Azure Portal:
  Entra ID > App registrations > $appDisplayName > API permissions > Grant admin consent
"@
}

# ---------------------------------------------------------------------------
# Create or reuse client secret
# ---------------------------------------------------------------------------

$existingSecret = Get-AzdEnv 'AZURE_CLIENT_SECRET'

if ($existingSecret) {
    Write-Host "Client secret already stored in azd env — skipping creation." -ForegroundColor Green
} else {
    Write-Host "Creating client secret (24-month expiry)..." -ForegroundColor Cyan
    $credential = az ad app credential reset `
        --id $clientId `
        --display-name "azd-$envName" `
        --years 2 `
        --output json | ConvertFrom-Json

    if ($LASTEXITCODE -ne 0) { throw "Failed to create client secret." }

    Set-AzdEnv 'AZURE_CLIENT_SECRET' $credential.password
    Write-Host "Client secret created and stored in azd env." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host "`n=== Pre-provision complete ===" -ForegroundColor Cyan
Write-Host "Tenant ID:  $tenantId"
Write-Host "Client ID:  $clientId"
Write-Host "App Name:   $appDisplayName"
Write-Host "API Scope:  api://$clientId/access_as_user"
Write-Host ""
