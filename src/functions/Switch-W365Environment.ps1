#Requires -Version 7.0

function Switch-W365Environment {
    <#
    .SYNOPSIS
        Switches between active Cloud PC environments for a user.
    .DESCRIPTION
        For users with multiple pre-provisioned Cloud PCs, this function
        lists available environments and provides connection guidance.

        W365 Switch (Task View) and W365 Boot Connection Center handle
        the actual session switching natively — this cmdlet manages the
        orchestration layer: identifying which CPC maps to which project,
        and optionally powering on/off Frontline CPCs.

        For non-Frontline CPCs, "switching" is simply connecting to a
        different already-running Cloud PC. No disk swap occurs.
    .PARAMETER UserPrincipalName
        The user whose environments to manage.
    .PARAMETER ProjectName
        The target project to switch to.
    .PARAMETER PowerOffCurrent
        Power off the current Cloud PC (Frontline only) after switching.
    .EXAMPLE
        Switch-W365Environment -UserPrincipalName "dev@contoso.com" -ProjectName "project-beta"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$UserPrincipalName,

        [string]$ProjectName,

        [switch]$PowerOffCurrent
    )

    Write-Host "Retrieving Cloud PCs for $UserPrincipalName..." -ForegroundColor Cyan

    $cloudPCs = Get-W365CloudPC -UserPrincipalName $UserPrincipalName

    if (-not $cloudPCs -or $cloudPCs.Count -eq 0) {
        Write-Warning "No Cloud PCs found for $UserPrincipalName."
        return
    }

    # Display available environments
    Write-Host "`nAvailable Cloud PC environments:" -ForegroundColor White
    Write-Host ('-' * 80)

    $i = 0
    foreach ($cpc in $cloudPCs) {
        $i++
        $statusColor = switch ($cpc.status) {
            'provisioned' { 'Green' }
            'running'     { 'Green' }
            'poweredOff'  { 'Yellow' }
            default       { 'Gray' }
        }
        $project = $cpc.projectName ?? 'unassigned'
        Write-Host "  [$i] " -NoNewline -ForegroundColor Cyan
        Write-Host "$($cpc.displayName)" -NoNewline -ForegroundColor White
        Write-Host " | $($cpc.status)" -NoNewline -ForegroundColor $statusColor
        Write-Host " | Project: $project" -ForegroundColor Gray
        Write-Host "      ID: $($cpc.id) | SKU: $($cpc.servicePlanName)" -ForegroundColor DarkGray
    }
    Write-Host ('-' * 80)

    if ($ProjectName) {
        $target = $cloudPCs | Where-Object { $_.projectName -eq $ProjectName }
        if (-not $target) {
            Write-Warning "No active Cloud PC found for project '$ProjectName'."
            Write-Host "Available projects: $(($cloudPCs | ForEach-Object { $_.projectName }) -join ', ')"
            return
        }

        Write-Host "`nTarget: $($target.displayName) (project: $ProjectName)" -ForegroundColor Green

        # Power on if Frontline and powered off
        if ($target.powerState -eq 'poweredOff') {
            Write-Host "Powering on Cloud PC..." -ForegroundColor Yellow
            try {
                Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$($target.id)/start" -Method POST
                Write-Host "Power-on initiated. May take 1-2 minutes." -ForegroundColor Green
            }
            catch {
                Write-Warning "Could not power on (may not be a Frontline CPC): $_"
            }
        }

        # Power off current if requested
        if ($PowerOffCurrent) {
            $current = $cloudPCs | Where-Object { $_.powerState -eq 'running' -and $_.id -ne $target.id }
            foreach ($c in $current) {
                Write-Host "Powering off $($c.displayName)..." -ForegroundColor Yellow
                try {
                    Invoke-GraphRequest -Uri "/deviceManagement/virtualEndpoint/cloudPCs/$($c.id)/stop" -Method POST
                }
                catch {
                    Write-Warning "Could not power off $($c.displayName): $_"
                }
            }
        }

        Write-Host "`nTo connect, the user can:" -ForegroundColor White
        Write-Host "  - Windows 365 Switch: Use Task View (Win+Tab) and select the Cloud PC desktop" -ForegroundColor Gray
        Write-Host "  - Windows 365 Boot: Cloud PC appears in Connection Center at logon" -ForegroundColor Gray
        Write-Host "  - Web: https://windows365.microsoft.com" -ForegroundColor Gray
        Write-Host "  - Windows 365 app: Select the target Cloud PC from the list" -ForegroundColor Gray
    }

    return $cloudPCs
}
