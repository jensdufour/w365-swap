#Requires -Version 7.0

function Import-W365Environment {
    <#
    .SYNOPSIS
        Imports a VHD from Azure Storage to provision a new Cloud PC.
    .DESCRIPTION
        Uses the Graph Beta importSnapshot API to import a VHD file from a
        customer-managed storage account. This provisions a NEW Cloud PC
        for the specified user based on the imported VHD.

        IMPORTANT: This does NOT swap the disk of an existing Cloud PC.
        It creates a new Cloud PC. The user must have an available W365 license.
        Provisioning typically takes 15-45 minutes.

        Note on naming: VHDs produced by Export-W365Environment land in a
        Windows-365-managed container called `windows365-share-ent-<suffix>`
        with a service-chosen name `CPC_<cloudPcId>_<guid>.vhd`. You must
        supply both the actual ContainerName and the actual BlobName here.
        Locate them via the Azure portal, az cli, or the W365 Swap web portal.
    .PARAMETER UserId
        The Entra ID user ID to assign the imported Cloud PC to.
    .PARAMETER StorageAccountId
        Azure resource ID of the storage account containing the VHD.
    .PARAMETER ContainerName
        Blob container name (e.g. `windows365-share-ent-abc123`).
    .PARAMETER BlobName
        Full blob name of the VHD file (e.g. `CPC_<id>_<guid>.vhd`).
    .PARAMETER GuestStateBlobName
        Optional blob name for the VM guest state file (.vmgs). Required for
        Gen2 VHDs you uploaded yourself; not produced by createSnapshot.
    .EXAMPLE
        Import-W365Environment -UserId "user-guid" -StorageAccountId $storageId `
            -ContainerName "windows365-share-ent-abc123" `
            -BlobName "CPC_4b5ad5e0-6a0b-4ffc-818d-36bb23cf4dbd_xxx.vhd"
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$UserId,

        [Parameter(Mandatory)]
        [string]$StorageAccountId,

        [Parameter(Mandatory)]
        [string]$ContainerName,

        [Parameter(Mandatory)]
        [string]$BlobName,

        [string]$GuestStateBlobName
    )

    if (-not $PSCmdlet.ShouldProcess($BlobName, "Import VHD and provision Cloud PC for user $UserId")) {
        return
    }

    Write-Host "Importing VHD '$BlobName' from container '$ContainerName' for user $UserId..." -ForegroundColor Cyan
    Write-Host "This will provision a NEW Cloud PC. Estimated time: 15-45 minutes." -ForegroundColor Yellow

    $sourceFiles = @(
        @{
            sourceType      = 'azureStorageAccount'
            fileType        = 'dataFile'
            storageBlobInfo = @{
                storageAccountId = $StorageAccountId
                containerName    = $ContainerName
                blobName         = $BlobName
            }
        }
    )

    if ($GuestStateBlobName) {
        $sourceFiles += @{
            sourceType      = 'azureStorageAccount'
            fileType        = 'virtualMachineGuestState'
            storageBlobInfo = @{
                storageAccountId = $StorageAccountId
                containerName    = $ContainerName
                blobName         = $GuestStateBlobName
            }
        }
    }

    $body = @{
        sourceFiles    = $sourceFiles
        assignedUserId = $UserId
    }

    try {
        $result = Invoke-GraphRequest -Uri '/deviceManagement/virtualEndpoint/snapshots/importSnapshot' `
            -Method POST -Body $body
    }
    catch {
        Write-Error "Failed to import snapshot: $_"
        throw
    }

    $operationId = New-OperationId -Type 'import'
    Add-OperationRecord -OperationId $operationId -Type 'import' -CloudPcId 'pending' -ProjectName $BlobName

    Write-Host "Import initiated. Operation: $operationId" -ForegroundColor Green
    Write-Host "Import status: $($result.importStatus)" -ForegroundColor Gray
    Write-Host "Policy: $($result.policyName)" -ForegroundColor Gray

    return @{
        operationId  = $operationId
        importResult = $result
        status       = $result.importStatus
    }
}
