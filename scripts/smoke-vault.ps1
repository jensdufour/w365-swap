#Requires -Version 7.0

<#
.SYNOPSIS
    End-to-end smoke test for Mosaic v0 API with a real Entra ID token.
.DESCRIPTION
    Exercises every public endpoint under a real signed-in user identity:
      1. Acquire a v2 access token from Azure CLI (preauthorized).
      2. GET  /api/health            -> 200
      3. POST /api/states            -> 201 (creates a pending state)
      4. GET  /api/states            -> 200 (must include the new state)
      5. GET  /api/states/{id}       -> 200 (reads back the new state)
      6. POST /api/chunks/upload-sas -> 200 (mints a real SAS)
      7. GET  /api/chunks/{hash}/download-sas -> 200
    Fails fast on any non-2xx response. Use as a deploy gate.
#>

$ErrorActionPreference = 'Stop'

# --- Env -----------------------------------------------------------------
$cid = (azd env get-value AZURE_CLIENT_ID).Trim()
$apiUrl = (azd env get-value AZURE_FUNCTION_APP_URL).Trim()
if (-not $cid -or -not $apiUrl) { throw "AZURE_CLIENT_ID or AZURE_FUNCTION_APP_URL missing from azd env." }

Write-Host "API:    $apiUrl" -ForegroundColor DarkGray
Write-Host "Aud:    api://$cid"     -ForegroundColor DarkGray

# --- Token ---------------------------------------------------------------
$token = az account get-access-token --resource "api://$cid" --query accessToken -o tsv
if ($LASTEXITCODE -ne 0 -or -not $token) { throw "Token acquisition failed." }

$headers = @{ Authorization = "Bearer $token" }

# --- Helper --------------------------------------------------------------
function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Block
    )
    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    try {
        $result = & $Block
        Write-Host "OK" -ForegroundColor Green
        return $result
    } catch {
        $resp = $_.Exception.Response
        $status = if ($resp) { [int]$resp.StatusCode } else { '?' }
        $body = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        Write-Host "FAIL ($status): $body" -ForegroundColor Red
        throw
    }
}

# --- 1. Health -----------------------------------------------------------
Invoke-Step '/health' {
    $r = Invoke-RestMethod -Method Get -Uri "$apiUrl/api/health"
    Write-Host ($r | ConvertTo-Json -Compress)
}

# --- 2. POST /states  (create a pending state) --------------------------
$createBody = @{ label = 'smoke-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'); manifestVersion = 1 } | ConvertTo-Json
$state = Invoke-Step 'POST /states' {
    Invoke-RestMethod -Method Post -Uri "$apiUrl/api/states" -Headers $headers -Body $createBody -ContentType 'application/json'
}
Write-Host "  created id: $($state.id)" -ForegroundColor DarkGray
Write-Host "  status:     $($state.status)" -ForegroundColor DarkGray
Write-Host "  userId:     $($state.userId)" -ForegroundColor DarkGray

# --- 3. GET /states  (list, must include the new one) -------------------
$list = Invoke-Step 'GET /states' {
    Invoke-RestMethod -Method Get -Uri "$apiUrl/api/states" -Headers $headers
}
$states = if ($list.states) { @($list.states) } elseif ($list -is [array]) { $list } else { @($list) }
Write-Host "  states returned: $($states.Count)" -ForegroundColor DarkGray
$found = $states | Where-Object { $_.id -eq $state.id }
if (-not $found) { throw "Created state $($state.id) not in /states list." }
Write-Host "  new state found in list" -ForegroundColor DarkGray

# --- 4. GET /states/{id}  (read by id) -----------------------------------
$one = Invoke-Step "GET /states/$($state.id)" {
    Invoke-RestMethod -Method Get -Uri "$apiUrl/api/states/$($state.id)" -Headers $headers
}
if ($one.id -ne $state.id) { throw "GET /states/{id} returned wrong record." }
Write-Host "  round-trip OK" -ForegroundColor DarkGray
# Belt-and-suspenders: list/get responses must NEVER include the wrappedDek.
if ($one.PSObject.Properties['wrappedDek']) { throw "GET /states/{id} leaked wrappedDek!" }
Write-Host "  no wrappedDek leak in metadata response" -ForegroundColor DarkGray

# --- 4b. POST /states/{id}/dek  (envelope-encryption round-trip) ---------
$dekResp1 = Invoke-Step "POST /states/$($state.id)/dek" {
    Invoke-RestMethod -Method Post -Uri "$apiUrl/api/states/$($state.id)/dek" -Headers $headers
}
$dekBytes = [Convert]::FromBase64String($dekResp1.dek)
if ($dekBytes.Length -ne 32) { throw "DEK is $($dekBytes.Length) bytes; expected 32 (AES-256)." }
if ($dekResp1.algorithm -ne 'AES-256-GCM') { throw "Unexpected algorithm: $($dekResp1.algorithm)" }
if (-not $dekResp1.kekKid) { throw "Response missing kekKid." }
Write-Host "  DEK length: $($dekBytes.Length) bytes (AES-256)" -ForegroundColor DarkGray
Write-Host "  algorithm:  $($dekResp1.algorithm)" -ForegroundColor DarkGray
Write-Host "  kekKid:     $($dekResp1.kekKid)" -ForegroundColor DarkGray

# Idempotency: same state, second call must return the same DEK (the wrap
# happened once at create-time and is stable for this StateRecord).
$dekResp2 = Invoke-RestMethod -Method Post -Uri "$apiUrl/api/states/$($state.id)/dek" -Headers $headers
if ($dekResp2.dek -ne $dekResp1.dek) { throw "DEK unwrap is non-deterministic for the same state!" }
Write-Host "  re-unwrap is stable across calls (same state)" -ForegroundColor DarkGray

# Per-state isolation: a NEW state must have a DIFFERENT DEK.
$state2 = Invoke-RestMethod -Method Post -Uri "$apiUrl/api/states" -Headers $headers -Body (@{label='isolation'} | ConvertTo-Json) -ContentType 'application/json'
$dekResp3 = Invoke-RestMethod -Method Post -Uri "$apiUrl/api/states/$($state2.id)/dek" -Headers $headers
if ($dekResp3.dek -eq $dekResp1.dek) { throw "Two different states share the same DEK \u2014 broken isolation!" }
Write-Host "  per-state DEK isolation verified (different state \u2192 different DEK)" -ForegroundColor DarkGray

# Cross-user isolation: same caller asking for a NON-EXISTENT state must 404
# (we don't have a second user handy to test true cross-user, but a random
# UUID exercises the same partition-key check that enforces it).
try {
    $bogusId = [guid]::NewGuid().ToString()
    Invoke-RestMethod -Method Post -Uri "$apiUrl/api/states/$bogusId/dek" -Headers $headers | Out-Null
    throw "Bogus state id unexpectedly returned a DEK."
} catch {
    $st = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($st -ne 404) { throw "Bogus state id returned $st (expected 404)." }
    Write-Host "  bogus state id \u2192 404 (no info leak)" -ForegroundColor DarkGray
}

# --- 5. POST /chunks/upload-sas  (mint upload SAS) -----------------------
# Hash must match ^[a-f0-9]{64}$ (BLAKE3 fingerprint, hex-encoded).
$fakeHash = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Min 0 -Max 16) })
$sasBody = @{ hash = $fakeHash; size = 1024 } | ConvertTo-Json
$upload = Invoke-Step 'POST /chunks/upload-sas' {
    Invoke-RestMethod -Method Post -Uri "$apiUrl/api/chunks/upload-sas" -Headers $headers -Body $sasBody -ContentType 'application/json'
}
if (-not $upload.url) { throw "upload-sas response missing 'url'." }
Write-Host "  url length: $($upload.url.Length)" -ForegroundColor DarkGray
Write-Host "  expires:    $($upload.expiresOn)" -ForegroundColor DarkGray

# --- 6. GET /chunks/{hash}/download-sas ----------------------------------
$dl = Invoke-Step "GET /chunks/$fakeHash/download-sas" {
    Invoke-RestMethod -Method Get -Uri "$apiUrl/api/chunks/$fakeHash/download-sas" -Headers $headers
}
if (-not $dl.url) { throw "download-sas response missing 'url'." }
Write-Host "  url length: $($dl.url.Length)" -ForegroundColor DarkGray

# --- Negative: bogus token still 401 ------------------------------------
Write-Host ""
Write-Host "=== Negative: bogus token must 401 ===" -ForegroundColor Cyan
try {
    Invoke-RestMethod -Method Get -Uri "$apiUrl/api/states" -Headers @{ Authorization = "Bearer not.a.token" } | Out-Null
    throw "Bogus token unexpectedly accepted."
} catch {
    $resp = $_.Exception.Response
    $status = if ($resp) { [int]$resp.StatusCode } else { 0 }
    if ($status -ne 401) { throw "Bogus token returned $status (expected 401)." }
    Write-Host "OK (401)" -ForegroundColor Green
}

Write-Host ""
Write-Host "All smoke checks passed." -ForegroundColor Green
