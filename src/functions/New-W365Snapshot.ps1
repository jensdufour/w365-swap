#Requires -Version 7.0

function New-W365Snapshot {
    <#
    .SYNOPSIS
        Creates an on-demand snapshot of a Cloud PC.
    .DESCRIPTION
        Triggers a manual snapshot via the Graph Beta API. The snapshot can later
        be used for restore operations or exported for archival.

        Note: Each Cloud PC can only have ONE manual snapshot at a time.
        Creating a new one overwrites the previous manual snapshot.
    .PARAMETER CloudPcId
        The ID of the Cloud PC to snapshot.
    .PARAMETER StorageAccountId
        Azure resource ID of the storage account to store the snapshot.
        If omitted, the snapshot is stored in W365 service-managed storage.
    .PARAMETER AccessTier
        Blob access tier for the exported snapshot. Default: hot.
    .PARAMETER Label
        A label for local tracking purposes (stored in state file only).
    .EXAMPLE
        New-W365Snapshot -CloudPcId "abc123" -Label "pre-refactor"
    .EXAMPLE
        New-W365Snapshot -CloudPcId "abc123" -StorageAccountId "/subscriptions/.../storageAccounts/stw365swap"
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$CloudPcId,

        [string]$StorageAccountId,

        [ValidateSet('hot', 'cool', 'cold', 'archive')]
        [string]$AccessTier = 'hot',

        [string]$Label
    )

    if (-not $PSCmdlet.ShouldProcess($CloudPcId, 'Create snapshot')) {
        return
    }

    $body = @{}
    if ($StorageAccountId) {
        $body['storageAccountId'] = $StorageAccountId
    }
    if ($AccessTier -ne 'hot') {
        $body['accessTier'] = $AccessTier
    }

    Write-Host "Creating snapshot for Cloud PC $CloudPcId..." -ForegroundColor Cyan

    try {
        if ($body.Count -gt 0) {
            Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId/createSnapshot" `
                -Method POST -Body $body
        }
        else {
            Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId/createSnapshot" `
                -Method POST
        }
    }
    catch {
        Write-Error "Failed to create snapshot: $_"
        throw
    }

    # Track in local state
    $operationId = "snap-$CloudPcId-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Add-OperationRecord -OperationId $operationId -Type 'snapshot' -CloudPcId $CloudPcId -ProjectName ($Label ?? 'manual')

    Write-Host "Snapshot initiated. Operation: $operationId" -ForegroundColor Green
    Write-Host "Note: Only one manual snapshot per Cloud PC. Previous manual snapshot (if any) was overwritten." -ForegroundColor Yellow

    return @{
        operationId = $operationId
        cloudPcId   = $CloudPcId
        label       = $Label
        status      = 'inProgress'
    }
}
