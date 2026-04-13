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
    .PARAMETER ProjectName
        The project name to look up in the state file for the VHD path.
    .PARAMETER UserId
        The Entra ID user ID to assign the imported Cloud PC to.
    .PARAMETER StorageAccountId
        Azure resource ID of the storage account containing the VHD.
    .PARAMETER ContainerName
        Blob container name. Default: snapshots.
    .PARAMETER BlobName
        Full blob name of the VHD file. If omitted, resolved from state file.
    .PARAMETER GuestStateBlobName
        Optional blob name for the VM guest state file.
    .EXAMPLE
        Import-W365Environment -ProjectName "project-alpha" -UserId "user-guid" -StorageAccountId $storageId
    .EXAMPLE
        Import-W365Environment -UserId "user-guid" -StorageAccountId $storageId -ContainerName "snapshots" -BlobName "dev_contoso_com/project-alpha/20260413.vhd"
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$ProjectName,

        [Parameter(Mandatory)]
        [string]$UserId,

        [Parameter(Mandatory)]
        [string]$StorageAccountId,

        [string]$ContainerName = 'snapshots',
        [string]$BlobName,
        [string]$GuestStateBlobName
    )

    # Resolve blob name from state if not specified
    if (-not $BlobName -and $ProjectName) {
        $state = Get-SwapState
        $envRecord = $state.environments | Where-Object {
            $_.projectName -eq $ProjectName -and $_.status -eq 'archived'
        } | Sort-Object -Property lastModified -Descending | Select-Object -First 1

        if (-not $envRecord) {
            throw "No archived environment found for project '$ProjectName'. Specify -BlobName explicitly."
        }

        $BlobName = $envRecord.blobPath -replace '^snapshots/', ''
        Write-Host "Resolved VHD from state: $BlobName" -ForegroundColor Gray
    }

    if (-not $BlobName) {
        throw 'Either -ProjectName (with archived state) or -BlobName must be specified.'
    }

    if (-not $PSCmdlet.ShouldProcess($BlobName, "Import VHD and provision Cloud PC for user $UserId")) {
        return
    }

    Write-Host "Importing VHD '$BlobName' for user $UserId..." -ForegroundColor Cyan
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

    # Track in state
    $operationId = "import-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Add-OperationRecord -OperationId $operationId -Type 'import' -CloudPcId 'pending' -ProjectName ($ProjectName ?? $BlobName)

    if ($ProjectName) {
        Add-EnvironmentRecord -CloudPcId 'pending' -ProjectName $ProjectName `
            -Status 'importing' -UserPrincipalName ($result.assignedUserPrincipalName ?? '') `
            -BlobPath "$ContainerName/$BlobName"
    }

    Write-Host "Import initiated. Operation: $operationId" -ForegroundColor Green
    Write-Host "Import status: $($result.importStatus)" -ForegroundColor Gray
    Write-Host "Policy: $($result.policyName)" -ForegroundColor Gray

    return @{
        operationId = $operationId
        importResult = $result
        status       = $result.importStatus
    }
}
