#Requires -Version 7.0

<#
.SYNOPSIS
    W365 Swap PowerShell module — orchestrates Windows 365 Cloud PC environment switching.
.DESCRIPTION
    Provides cmdlets for managing multiple Windows 365 Cloud PC environments,
    including snapshot creation, VHD export/import, and multi-CPC switching.

    Uses Microsoft Graph Beta API. Not supported for production use.
#>

$ErrorActionPreference = 'Stop'

# Load helpers
$helperFiles = Get-ChildItem -Path (Join-Path $PSScriptRoot 'helpers') -Filter '*.ps1' -ErrorAction SilentlyContinue
foreach ($file in $helperFiles) {
    . $file.FullName
}

# Load public functions
$functionFiles = Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions') -Filter '*.ps1' -ErrorAction SilentlyContinue
foreach ($file in $functionFiles) {
    . $file.FullName
}

# Export public functions
$publicFunctions = @(
    'Connect-W365Swap'
    'Get-W365CloudPC'
    'New-W365Snapshot'
    'Export-W365Environment'
    'Import-W365Environment'
    'Switch-W365Environment'
    'Restore-W365Environment'
    'Get-W365SwapStatus'
    'Remove-W365ArchivedEnvironment'
)

Export-ModuleMember -Function $publicFunctions
