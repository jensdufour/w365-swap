#Requires -Version 7.0

<#
.SYNOPSIS
    Common helper utilities shared across W365 Swap cmdlets.
#>

function New-OperationId {
    <#
    .SYNOPSIS
        Generates a deterministic operation ID for local state tracking.
    .DESCRIPTION
        Returns an ID of the form "<type>[-<cloudPcId>]-<yyyyMMddHHmmss>" —
        the same pattern previously inlined in every cmdlet that records an
        operation.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('snapshot', 'export', 'import', 'restore', 'reprovision')]
        [string]$Type,

        [string]$CloudPcId
    )

    $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
    if ($CloudPcId) {
        return "$Type-$CloudPcId-$timestamp"
    }
    return "$Type-$timestamp"
}
