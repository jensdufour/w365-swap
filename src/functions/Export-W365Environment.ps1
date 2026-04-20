#Requires -Version 7.0

function Export-W365Environment {
    <#
    .SYNOPSIS
        Exports a Cloud PC environment as a VHD snapshot to Azure Storage.
    .DESCRIPTION
        Creates a snapshot of the specified Cloud PC and stores it in a
        customer-managed Azure Storage account. The VHD is organized by
        user and project name for later retrieval.

        This is the "archive" operation — used to free up a W365 license
        while preserving the environment state for later re-import.
    .PARAMETER CloudPcId
        The ID of the Cloud PC to export.
    .PARAMETER ProjectName
        A project label for organizing the exported VHD.
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
    $upn = $cloudPc.userPrincipalName

    Write-Host "Exporting Cloud PC '$($cloudPc.displayName)' for $upn as project '$ProjectName'..." -ForegroundColor Cyan

    # Create snapshot to customer storage
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

    $blobPath = "snapshots/$($upn.Replace('@', '_'))/$ProjectName/$(Get-Date -Format 'yyyyMMdd-HHmmss').vhd"

    # Track in state
    $operationId = New-OperationId -Type 'export' -CloudPcId $CloudPcId
    Add-EnvironmentRecord -CloudPcId $CloudPcId -ProjectName $ProjectName `
        -Status 'exporting' -UserPrincipalName $upn -BlobPath $blobPath
    Add-OperationRecord -OperationId $operationId -Type 'export' -CloudPcId $CloudPcId -ProjectName $ProjectName

    Write-Host "Export initiated. Operation: $operationId" -ForegroundColor Green
    Write-Host "Expected blob path: $blobPath" -ForegroundColor Gray
    Write-Host "Use Get-W365SwapStatus -OperationId '$operationId' to check progress." -ForegroundColor Gray

    return @{
        operationId = $operationId
        cloudPcId   = $CloudPcId
        projectName = $ProjectName
        blobPath    = $blobPath
        status      = 'inProgress'
    }
}
