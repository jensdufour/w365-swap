#Requires -Version 7.0

function Get-W365CloudPC {
    <#
    .SYNOPSIS
        Lists Cloud PCs for a user or all Cloud PCs in the tenant.
    .DESCRIPTION
        Queries the Graph Beta API to retrieve Cloud PC information.
        Returns enriched objects with local state tracking data.
    .PARAMETER UserPrincipalName
        Filter Cloud PCs by user. If omitted, returns all Cloud PCs.
    .PARAMETER CloudPcId
        Get a specific Cloud PC by ID.
    .PARAMETER IncludeSnapshots
        Also retrieve snapshot information for each Cloud PC.
    .EXAMPLE
        Get-W365CloudPC -UserPrincipalName "dev@contoso.com"
    .EXAMPLE
        Get-W365CloudPC -CloudPcId "4b5ad5e0-6a0b-4ffc-818d-36bb23cf4dbd"
    #>
    [CmdletBinding(DefaultParameterSetName = 'List')]
    param(
        [Parameter(ParameterSetName = 'List')]
        [string]$UserPrincipalName,

        [Parameter(ParameterSetName = 'ById', Mandatory)]
        [string]$CloudPcId,

        [switch]$IncludeSnapshots
    )

    if ($CloudPcId) {
        # Validate GUID format to prevent path traversal
        if ($CloudPcId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
            throw "Invalid CloudPcId format. Expected a GUID."
        }

        $cloudPc = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId"

        if ($IncludeSnapshots) {
            $snapshots = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$CloudPcId/retrieveSnapshots"
            $cloudPc | Add-Member -NotePropertyName 'snapshots' -NotePropertyValue $snapshots.value -Force
        }

        return $cloudPc
    }

    $filter = ''
    if ($UserPrincipalName) {
        # Sanitize UPN to prevent OData injection
        if ($UserPrincipalName -notmatch '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$') {
            throw "Invalid UserPrincipalName format."
        }
        $escapedUpn = $UserPrincipalName.Replace("'", "''")
        $filter = "?`$filter=userPrincipalName eq '$escapedUpn'"
    }

    $response = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs$filter"
    $cloudPCs = $response.value

    if ($IncludeSnapshots) {
        foreach ($cpc in $cloudPCs) {
            try {
                $snapshots = Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$($cpc.id)/retrieveSnapshots"
                $cpc | Add-Member -NotePropertyName 'snapshots' -NotePropertyValue $snapshots.value -Force
            }
            catch {
                Write-Warning "Could not retrieve snapshots for $($cpc.displayName): $_"
            }
        }
    }

    # Enrich with local state
    try {
        $state = Get-SwapState
        foreach ($cpc in $cloudPCs) {
            $envRecord = $state.environments | Where-Object { $_.cloudPcId -eq $cpc.id } | Select-Object -First 1
            $cpc | Add-Member -NotePropertyName 'projectName' -NotePropertyValue ($envRecord.projectName ?? 'unassigned') -Force
            $cpc | Add-Member -NotePropertyName 'swapStatus' -NotePropertyValue ($envRecord.status ?? 'untracked') -Force
        }
    }
    catch {
        # State file may not exist yet
    }

    return $cloudPCs
}
