#Requires -Version 7.0

function Export-W365Environment {
    <#
    .SYNOPSIS
        Exports a Cloud PC environment as a VHD snapshot to Azure Storage.
    .DESCRIPTION
        Triggers Graph Beta `createSnapshot` against a customer-managed storage
        account. The VHD is written into a Windows-365-managed container
        ("windows365-share-ent-<suffix>") with a service-chosen blob name in
        the form `CPC_<cloudPcId>_<guid>.vhd`. There is no way to choose the
        container or blob name on this call; the W365 service decides.

        This is the "archive" operation — used to free up a W365 license
        while preserving the environment state for later re-import via
        Import-W365Environment.
    .PARAMETER CloudPcId
        The ID of the Cloud PC to export.
    .PARAMETER ProjectName
        A label recorded on the local operation log for your reference.
    .PARAMETER StorageAccountId
        Azure resource ID of the target storage account.
    .PARAMETER AccessTier
        Blob access tier. Use 'cool' or 'archive' for long-term storage.
    .EXAMPLE
        Export-W365Environment -CloudPcId "abc123" -ProjectName "project-alpha" -StorageAccountId $storageId
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$CloudPcId,

        [Parameter(Mandatory)]
        [string]$ProjectName,

        [Parameter(Mandatory)]
        [string]$StorageAccountId,

        [ValidateSet('hot', 'cool', 'cold', 'archive')]
        [string]$AccessTier = 'cool'
    )

    if (-not $PSCmdlet.ShouldProcess($CloudPcId, "Export environment '$ProjectName' to storage")) {
        return
    }

    # Get Cloud PC details first
    $cloudPc = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId"

    Write-Host "Exporting Cloud PC '$($cloudPc.displayName)' as project '$ProjectName'..." -ForegroundColor Cyan

    # Create snapshot to customer storage. W365 chooses the container + blob
    # name; we don't get them back from this call.
    $body = @{
        storageAccountId = $StorageAccountId
        accessTier       = $AccessTier
    }

    try {
        Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId/createSnapshot" `
            -Method POST -Body $body
    }
    catch {
        Write-Error "Failed to create snapshot for export: $_"
        throw
    }

    $operationId = New-OperationId -Type 'export' -CloudPcId $CloudPcId
    Add-OperationRecord -OperationId $operationId -Type 'export' -CloudPcId $CloudPcId -ProjectName $ProjectName

    Write-Host "Export initiated. Operation: $operationId" -ForegroundColor Green
    Write-Host "The VHD will land in a 'windows365-share-ent-*' container on the target storage account as 'CPC_$CloudPcId`_<guid>.vhd' (typically 20-60 min)." -ForegroundColor Gray
    Write-Host "Use the Azure portal, az cli, or the web portal to find and reference the blob when importing." -ForegroundColor Gray

    return @{
        operationId = $operationId
        cloudPcId   = $CloudPcId
        projectName = $ProjectName
        status      = 'inProgress'
    }
}
