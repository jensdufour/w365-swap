#Requires -Version 7.0

<#
.SYNOPSIS
    Local state management for W365 Swap environment tracking.
.DESCRIPTION
    Tracks which Cloud PCs are active, archived, and their associated
    project names and snapshot metadata. State is stored as a JSON file.
#>

$script:StateFilePath = $null

function Initialize-StateFile {
    <#
    .SYNOPSIS
        Initializes or loads the state file.
    #>
    [CmdletBinding()]
    param(
        [string]$Path
    )

    $script:StateFilePath = $Path

    if (-not (Test-Path $Path)) {
        $initialState = @{
            version      = '1.0'
            lastModified = (Get-Date -Format 'o')
            environments = @()
            operations   = @()
        }
        $initialState | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding utf8
    }
}

function Get-SwapState {
    <#
    .SYNOPSIS
        Reads the current state from disk.
    #>
    [CmdletBinding()]
    param()

    if (-not $script:StateFilePath -or -not (Test-Path $script:StateFilePath)) {
        throw 'State file not initialized. Run Connect-W365Swap first.'
    }

    return Get-Content -Path $script:StateFilePath -Raw | ConvertFrom-Json -Depth 10
}

function Save-SwapState {
    <#
    .SYNOPSIS
        Writes updated state to disk.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$State
    )

    $State.lastModified = (Get-Date -Format 'o')
    $State | ConvertTo-Json -Depth 10 | Set-Content -Path $script:StateFilePath -Encoding utf8
}

function Add-EnvironmentRecord {
    <#
    .SYNOPSIS
        Adds or updates an environment record in the state.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CloudPcId,

        [Parameter(Mandatory)]
        [string]$ProjectName,

        [Parameter(Mandatory)]
        [ValidateSet('active', 'archived', 'importing', 'exporting')]
        [string]$Status,

        [string]$UserPrincipalName,
        [string]$BlobPath,
        [string]$SnapshotId
    )

    $state = Get-SwapState

    $envList = [System.Collections.ArrayList]@($state.environments)

    $existing = $envList | Where-Object { $_.cloudPcId -eq $CloudPcId -and $_.projectName -eq $ProjectName }
    if ($existing) {
        $existing.status = $Status
        $existing.lastModified = (Get-Date -Format 'o')
        if ($BlobPath) { $existing.blobPath = $BlobPath }
        if ($SnapshotId) { $existing.snapshotId = $SnapshotId }
    }
    else {
        $record = @{
            cloudPcId         = $CloudPcId
            projectName       = $ProjectName
            status            = $Status
            userPrincipalName = $UserPrincipalName
            blobPath          = $BlobPath
            snapshotId        = $SnapshotId
            createdAt         = (Get-Date -Format 'o')
            lastModified      = (Get-Date -Format 'o')
        }
        $envList.Add($record) | Out-Null
    }

    $state.environments = @($envList)
    Save-SwapState -State $state
}

function Add-OperationRecord {
    <#
    .SYNOPSIS
        Logs an async operation for status tracking.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$OperationId,

        [Parameter(Mandatory)]
        [ValidateSet('snapshot', 'export', 'import', 'restore', 'reprovision')]
        [string]$Type,

        [Parameter(Mandatory)]
        [string]$CloudPcId,

        [string]$ProjectName,

        [ValidateSet('inProgress', 'completed', 'failed')]
        [string]$Status = 'inProgress'
    )

    $state = Get-SwapState

    $opList = [System.Collections.ArrayList]@($state.operations)
    $opList.Add(@{
        operationId = $OperationId
        type        = $Type
        cloudPcId   = $CloudPcId
        projectName = $ProjectName
        status      = $Status
        startedAt   = (Get-Date -Format 'o')
        completedAt = $null
    }) | Out-Null

    # Keep only last 100 operations
    if ($opList.Count -gt 100) {
        $opList = [System.Collections.ArrayList]@($opList | Select-Object -Last 100)
    }

    $state.operations = @($opList)
    Save-SwapState -State $state
}

function Update-OperationStatus {
    <#
    .SYNOPSIS
        Updates the status of a tracked operation.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$OperationId,

        [Parameter(Mandatory)]
        [ValidateSet('inProgress', 'completed', 'failed')]
        [string]$Status
    )

    $state = Get-SwapState
    $op = $state.operations | Where-Object { $_.operationId -eq $OperationId }
    if ($op) {
        $op.status = $Status
        if ($Status -in @('completed', 'failed')) {
            $op.completedAt = (Get-Date -Format 'o')
        }
        Save-SwapState -State $state
    }
}

function Get-EnvironmentsByUser {
    <#
    .SYNOPSIS
        Returns all environment records for a given user.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$UserPrincipalName
    )

    $state = Get-SwapState
    return $state.environments | Where-Object { $_.userPrincipalName -eq $UserPrincipalName }
}
