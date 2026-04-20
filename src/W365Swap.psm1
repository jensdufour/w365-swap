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

# Export all loaded functions to the module scope.
# The manifest (W365Swap.psd1) is the authoritative list of what users see;
# FunctionsToExport there filters this wildcard down to the public surface.
Export-ModuleMember -Function *
