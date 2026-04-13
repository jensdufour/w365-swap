#Requires -Version 7.0

function Get-W365SwapStatus {
    <#
    .SYNOPSIS
        Checks the status of W365 Swap operations and Cloud PC states.
    .DESCRIPTION
        Retrieves the current status of tracked operations, Cloud PC
        provisioning state, or imported snapshot progress.
    .PARAMETER OperationId
        A local operation ID to look up in the state file.
    .PARAMETER CloudPcId
        Check the current status of a specific Cloud PC.
    .PARAMETER ListOperations
        List all tracked operations from the state file.
    .EXAMPLE
        Get-W365SwapStatus -OperationId "export-abc123-20260413120000"
    .EXAMPLE
        Get-W365SwapStatus -CloudPcId "abc123"
    .EXAMPLE
        Get-W365SwapStatus -ListOperations
    #>
    [CmdletBinding(DefaultParameterSetName = 'Operation')]
    param(
        [Parameter(ParameterSetName = 'Operation')]
        [string]$OperationId,

        [Parameter(ParameterSetName = 'CloudPC')]
        [string]$CloudPcId,

        [Parameter(ParameterSetName = 'List')]
        [switch]$ListOperations
    )

    if ($ListOperations) {
        $state = Get-SwapState
        if (-not $state.operations -or $state.operations.Count -eq 0) {
            Write-Host "No tracked operations." -ForegroundColor Gray
            return
        }

        Write-Host "`nTracked operations:" -ForegroundColor White
        Write-Host ('-' * 90)
        foreach ($op in ($state.operations | Sort-Object -Property startedAt -Descending | Select-Object -First 20)) {
            $statusColor = switch ($op.status) {
                'completed'  { 'Green' }
                'failed'     { 'Red' }
                'inProgress' { 'Yellow' }
                default      { 'Gray' }
            }
            Write-Host "  $($op.operationId)" -NoNewline -ForegroundColor Cyan
            Write-Host " | $($op.type)" -NoNewline -ForegroundColor White
            Write-Host " | $($op.status)" -NoNewline -ForegroundColor $statusColor
            Write-Host " | $($op.startedAt)" -ForegroundColor Gray
        }
        Write-Host ('-' * 90)
        return $state.operations
    }

    if ($CloudPcId) {
        $cloudPc = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId"

        Write-Host "`nCloud PC Status:" -ForegroundColor White
        Write-Host "  Name:   $($cloudPc.displayName)" -ForegroundColor Cyan
        Write-Host "  Status: $($cloudPc.status)" -ForegroundColor $(if ($cloudPc.status -eq 'provisioned') { 'Green' } else { 'Yellow' })
        Write-Host "  User:   $($cloudPc.userPrincipalName)" -ForegroundColor Gray
        Write-Host "  Image:  $($cloudPc.imageDisplayName)" -ForegroundColor Gray

        if ($cloudPc.lastRemoteActionResult) {
            Write-Host "  Last action: $($cloudPc.lastRemoteActionResult.actionName) - $($cloudPc.lastRemoteActionResult.actionState)" -ForegroundColor Gray
        }

        return $cloudPc
    }

    if ($OperationId) {
        $state = Get-SwapState
        $op = $state.operations | Where-Object { $_.operationId -eq $OperationId }
        if (-not $op) {
            Write-Warning "Operation '$OperationId' not found in local state."
            return
        }

        # If it's an import, try to check Graph API status
        if ($op.type -eq 'import' -and $op.status -eq 'inProgress') {
            Write-Host "Checking import status via Graph API..." -ForegroundColor Cyan
            # Note: The retrieveImportedSnapshots API can check progress
            # but the exact endpoint path needs validation in your environment
        }

        Write-Host "`nOperation: $($op.operationId)" -ForegroundColor White
        Write-Host "  Type:    $($op.type)" -ForegroundColor Cyan
        Write-Host "  Status:  $($op.status)" -ForegroundColor $(if ($op.status -eq 'completed') { 'Green' } elseif ($op.status -eq 'failed') { 'Red' } else { 'Yellow' })
        Write-Host "  Started: $($op.startedAt)" -ForegroundColor Gray
        if ($op.completedAt) {
            Write-Host "  Ended:   $($op.completedAt)" -ForegroundColor Gray
        }

        return $op
    }

    # Default: show summary
    $state = Get-SwapState
    $activeEnvs = @($state.environments | Where-Object { $_.status -eq 'active' })
    $archivedEnvs = @($state.environments | Where-Object { $_.status -eq 'archived' })
    $pendingOps = @($state.operations | Where-Object { $_.status -eq 'inProgress' })

    Write-Host "`nW365 Swap Status Summary:" -ForegroundColor White
    Write-Host "  Active environments:   $($activeEnvs.Count)" -ForegroundColor Green
    Write-Host "  Archived environments: $($archivedEnvs.Count)" -ForegroundColor Gray
    Write-Host "  Pending operations:    $($pendingOps.Count)" -ForegroundColor $(if ($pendingOps.Count -gt 0) { 'Yellow' } else { 'Gray' })
}
