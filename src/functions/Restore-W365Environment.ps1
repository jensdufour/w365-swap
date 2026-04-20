#Requires -Version 7.0

function Restore-W365Environment {
    <#
    .SYNOPSIS
        Restores a Cloud PC to a previous snapshot.
    .DESCRIPTION
        Uses the Graph Beta restore API to roll back a Cloud PC to one of
        its own previous snapshots. Lists available snapshots and restores
        the selected one.

        IMPORTANT: This only restores to the SAME Cloud PC's own snapshots.
        You cannot restore Cloud PC A using Cloud PC B's snapshot.
    .PARAMETER CloudPcId
        The ID of the Cloud PC to restore.
    .PARAMETER SnapshotId
        The ID of the snapshot to restore to. If omitted, lists available snapshots.
    .PARAMETER Latest
        Restore to the most recent snapshot automatically.
    .EXAMPLE
        Restore-W365Environment -CloudPcId "abc123" -Latest
    .EXAMPLE
        Restore-W365Environment -CloudPcId "abc123" -SnapshotId "CPC_xxx_yyy"
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$CloudPcId,

        [string]$SnapshotId,

        [switch]$Latest
    )

    # Get available snapshots
    $response = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId/retrieveSnapshots"
    $snapshots = $response.value | Where-Object { $_.status -eq 'ready' }

    if (-not $snapshots -or $snapshots.Count -eq 0) {
        Write-Warning "No ready snapshots available for Cloud PC $CloudPcId."
        return
    }

    if (-not $SnapshotId -and -not $Latest) {
        # Interactive: list snapshots
        Write-Host "`nAvailable snapshots for ${CloudPcId}:" -ForegroundColor White
        Write-Host ('-' * 80)
        $i = 0
        foreach ($snap in ($snapshots | Sort-Object -Property createdDateTime -Descending)) {
            $i++
            $healthColor = switch ($snap.healthCheckStatus) {
                'healthy'   { 'Green' }
                'unhealthy' { 'Red' }
                default     { 'Yellow' }
            }
            Write-Host "  [$i] " -NoNewline -ForegroundColor Cyan
            Write-Host "$($snap.createdDateTime)" -NoNewline -ForegroundColor White
            Write-Host " | $($snap.snapshotType)" -NoNewline -ForegroundColor Gray
            Write-Host " | Health: $($snap.healthCheckStatus)" -ForegroundColor $healthColor
            Write-Host "      ID: $($snap.id)" -ForegroundColor DarkGray
        }
        Write-Host ('-' * 80)
        Write-Host "Re-run with -SnapshotId '<id>' or -Latest to restore." -ForegroundColor Yellow
        return $snapshots
    }

    if ($Latest) {
        $targetSnapshot = $snapshots | Sort-Object -Property createdDateTime -Descending | Select-Object -First 1
        $SnapshotId = $targetSnapshot.id
        Write-Host "Selected latest snapshot: $($targetSnapshot.createdDateTime) ($SnapshotId)" -ForegroundColor Cyan
    }

    if (-not $PSCmdlet.ShouldProcess($CloudPcId, "Restore to snapshot $SnapshotId")) {
        return
    }

    Write-Host "Restoring Cloud PC $CloudPcId to snapshot $SnapshotId..." -ForegroundColor Cyan
    Write-Host "WARNING: All changes since this snapshot will be lost." -ForegroundColor Red

    $body = @{
        cloudPcSnapshotId = $SnapshotId
    }

    try {
        Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId/restore" `
            -Method POST -Body $body
    }
    catch {
        Write-Error "Failed to restore: $_"
        throw
    }

    $operationId = New-OperationId -Type 'restore' -CloudPcId $CloudPcId
    Add-OperationRecord -OperationId $operationId -Type 'restore' -CloudPcId $CloudPcId

    Write-Host "Restore initiated. Operation: $operationId" -ForegroundColor Green
    Write-Host "Estimated time: 5-15 minutes. User will be disconnected during restore." -ForegroundColor Yellow

    return @{
        operationId = $operationId
        cloudPcId   = $CloudPcId
        snapshotId  = $SnapshotId
        status      = 'inProgress'
    }
}
