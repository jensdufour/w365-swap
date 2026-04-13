#Requires -Version 7.0

function Remove-W365ArchivedEnvironment {
    <#
    .SYNOPSIS
        Removes an archived environment's VHD from storage and purges imported snapshots.
    .DESCRIPTION
        Cleans up archived VHDs from Azure Storage and optionally purges
        any imported snapshots from the W365 service-managed storage.
    .PARAMETER ProjectName
        The project name of the archived environment to remove.
    .PARAMETER UserPrincipalName
        Filter by user when multiple users have the same project name.
    .PARAMETER PurgeImported
        Also purge imported snapshots from W365 service storage.
    .EXAMPLE
        Remove-W365ArchivedEnvironment -ProjectName "project-alpha" -PurgeImported
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory)]
        [string]$ProjectName,

        [string]$UserPrincipalName,

        [switch]$PurgeImported
    )

    $state = Get-SwapState
    $filter = { $_.projectName -eq $ProjectName -and $_.status -eq 'archived' }
    if ($UserPrincipalName) {
        $filter = { $_.projectName -eq $ProjectName -and $_.status -eq 'archived' -and $_.userPrincipalName -eq $UserPrincipalName }
    }

    $envRecords = @($state.environments | Where-Object $filter)

    if ($envRecords.Count -eq 0) {
        Write-Warning "No archived environments found for project '$ProjectName'."
        return
    }

    foreach ($env in $envRecords) {
        if (-not $PSCmdlet.ShouldProcess("$($env.projectName) ($($env.blobPath))", 'Remove archived environment')) {
            continue
        }

        Write-Host "Removing archived environment: $($env.projectName)" -ForegroundColor Cyan

        # Delete blob from Azure Storage via az cli
        if ($env.blobPath) {
            $parts = $env.blobPath -split '/', 2
            $container = $parts[0]
            $blobName = $parts[1]

            Write-Host "Deleting blob: $($env.blobPath)" -ForegroundColor Yellow
            az storage blob delete --container-name $container --name $blobName `
                --account-name $env:STORAGE_ACCOUNT_NAME --auth-mode login 2>$null

            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Could not delete blob (may not exist or auth issue)."
            }
        }

        # Purge from W365 if requested
        if ($PurgeImported -and $env.snapshotId) {
            Write-Host "Purging imported snapshot from W365 service storage..." -ForegroundColor Yellow
            try {
                Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/snapshots/$($env.snapshotId)/purge" `
                    -Method POST
                Write-Host "Purge initiated." -ForegroundColor Green
            }
            catch {
                Write-Warning "Could not purge imported snapshot: $_"
            }
        }

        # Update state
        $env.status = 'removed'
        $env.lastModified = (Get-Date -Format 'o')
    }

    Save-SwapState -State $state
    Write-Host "Cleanup complete." -ForegroundColor Green
}
