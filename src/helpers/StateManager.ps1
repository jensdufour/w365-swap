#Requires -Version 7.0

<#
.SYNOPSIS
    Local state for W365 Swap operation tracking.
.DESCRIPTION
    Tracks asynchronous Graph operations (snapshot/export/import/restore)
    started by the CLI so users can correlate them later via Get-W365SwapStatus.
    State is stored as a JSON file scoped to the calling user.
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
        [ValidateSet('snapshot', 'export', 'import', 'restore')]
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
