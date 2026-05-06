@{
    RootModule        = 'W365Swap.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'a7f3c2e8-9d14-4b6a-8e5f-1c2d3e4f5a6b'
    Author            = 'LeafIT'
    CompanyName       = 'LeafIT'
    Copyright         = '(c) 2026 LeafIT. MIT License.'
    Description       = 'Orchestration toolkit for switching between pre-configured development environments on Windows 365 Cloud PCs. Uses Microsoft Graph Beta API.'

    PowerShellVersion = '7.0'

    FunctionsToExport = @(
        'Connect-W365Swap'
        'Get-W365CloudPC'
        'New-W365Snapshot'
        'Export-W365Environment'
        'Import-W365Environment'
        'Restore-W365Environment'
        'Get-W365SwapStatus'
    )

    CmdletsToExport   = @()
    VariablesToExport  = @()
    AliasesToExport    = @()

    PrivateData = @{
        PSData = @{
            Tags         = @('Windows365', 'CloudPC', 'DevBox', 'W365', 'Swap', 'VHD', 'Snapshot')
            LicenseUri   = 'https://github.com/yourorg/w365-swap/blob/main/LICENSE'
            ProjectUri   = 'https://github.com/yourorg/w365-swap'
            ReleaseNotes = @'
## 0.1.0
- Initial release
- Graph Beta API integration for Cloud PC snapshot management
- Export/Import VHD workflow for environment archival
- Multi-CPC switching orchestration
- Local state tracking for project-environment mapping
- Bicep infrastructure for Azure Storage deployment
'@
        }
    }
}
