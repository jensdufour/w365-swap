#Requires -Version 7.0

<#
.SYNOPSIS
    Microsoft Graph Beta API helper functions for W365 Swap.
.DESCRIPTION
    Handles authentication (client credentials + delegated) and provides
    typed wrappers around the Graph Beta REST API for Cloud PC operations.
#>

$script:GraphBaseUri = 'https://graph.microsoft.com/beta'
$script:AccessToken = $null
$script:TokenExpiry = [datetime]::MinValue

function Get-GraphAccessToken {
    <#
    .SYNOPSIS
        Acquires or returns a cached access token for Microsoft Graph.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TenantId,

        [Parameter(Mandatory)]
        [string]$ClientId,

        [Parameter()]
        [securestring]$ClientSecret,

        [Parameter()]
        [switch]$DeviceCode
    )

    if ($script:AccessToken -and [datetime]::UtcNow -lt $script:TokenExpiry.AddMinutes(-5)) {
        return $script:AccessToken
    }

    if ($DeviceCode) {
        $tokenResponse = Request-DeviceCodeToken -TenantId $TenantId -ClientId $ClientId
    }
    elseif ($ClientSecret) {
        $tokenResponse = Request-ClientCredentialToken -TenantId $TenantId -ClientId $ClientId -ClientSecret $ClientSecret
    }
    else {
        throw 'Either -ClientSecret or -DeviceCode must be specified.'
    }

    $script:AccessToken = $tokenResponse.access_token
    $script:TokenExpiry = [datetime]::UtcNow.AddSeconds($tokenResponse.expires_in)

    return $script:AccessToken
}

function Request-ClientCredentialToken {
    [CmdletBinding()]
    param(
        [string]$TenantId,
        [string]$ClientId,
        [securestring]$ClientSecret
    )

    $plainSecret = [System.Net.NetworkCredential]::new('', $ClientSecret).Password
    $body = @{
        grant_type    = 'client_credentials'
        client_id     = $ClientId
        client_secret = $plainSecret
        scope         = 'https://graph.microsoft.com/.default'
    }

    $response = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -Method Post -Body $body -ContentType 'application/x-www-form-urlencoded'

    return $response
}

function Request-DeviceCodeToken {
    [CmdletBinding()]
    param(
        [string]$TenantId,
        [string]$ClientId
    )

    $deviceCodeBody = @{
        client_id = $ClientId
        scope     = 'https://graph.microsoft.com/CloudPC.ReadWrite.All offline_access'
    }

    $deviceCode = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/devicecode" `
        -Method Post -Body $deviceCodeBody -ContentType 'application/x-www-form-urlencoded'

    Write-Host $deviceCode.message -ForegroundColor Yellow

    $tokenBody = @{
        grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
        client_id   = $ClientId
        device_code = $deviceCode.device_code
    }

    $timeout = [datetime]::UtcNow.AddSeconds($deviceCode.expires_in)
    while ([datetime]::UtcNow -lt $timeout) {
        Start-Sleep -Seconds $deviceCode.interval
        try {
            $response = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
                -Method Post -Body $tokenBody -ContentType 'application/x-www-form-urlencoded'
            return $response
        }
        catch {
            $errorDetail = $_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($errorDetail.error -eq 'authorization_pending') {
                continue
            }
            throw
        }
    }

    throw 'Device code authentication timed out.'
}

function Invoke-GraphRequest {
    <#
    .SYNOPSIS
        Sends an authenticated request to the Microsoft Graph Beta API.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Uri,

        [ValidateSet('GET', 'POST', 'PATCH', 'DELETE')]
        [string]$Method = 'GET',

        [object]$Body,

        [hashtable]$AdditionalHeaders = @{}
    )

    if (-not $script:AccessToken) {
        throw 'Not authenticated. Run Connect-W365Swap first.'
    }

    # Refresh token if near expiry
    if ([datetime]::UtcNow -ge $script:TokenExpiry.AddMinutes(-5)) {
        throw 'Access token expired. Run Connect-W365Swap again.'
    }

    $fullUri = if ($Uri.StartsWith('http')) { $Uri } else { "$($script:GraphBaseUri)$Uri" }

    $headers = @{
        'Authorization' = "Bearer $($script:AccessToken)"
        'Content-Type'  = 'application/json'
        'ConsistencyLevel' = 'eventual'
    }
    foreach ($key in $AdditionalHeaders.Keys) {
        $headers[$key] = $AdditionalHeaders[$key]
    }

    $params = @{
        Uri     = $fullUri
        Method  = $Method
        Headers = $headers
    }

    if ($Body) {
        $params['Body'] = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 10 }
    }

    try {
        $response = Invoke-RestMethod @params
        return $response
    }
    catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        $errorBody = $_.ErrorDetails.Message
        Write-Error "Graph API error ($statusCode): $errorBody"
        throw
    }
}

function Clear-GraphSession {
    <#
    .SYNOPSIS
        Clears the cached authentication token.
    #>
    $script:AccessToken = $null
    $script:TokenExpiry = [datetime]::MinValue
}
