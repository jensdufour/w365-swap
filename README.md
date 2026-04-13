# W365 Swap

Orchestration toolkit for switching between pre-configured development environments on Windows 365 Cloud PCs. Built as an alternative for organizations transitioning from Microsoft Dev Box.

> **Warning**: This project uses Microsoft Graph **beta** APIs which are subject to change and not supported for production use. Test thoroughly in a lab environment first.

## Problem

Microsoft Dev Box stopped accepting new customers on November 1, 2025, with capabilities being integrated into Windows 365. However, W365 currently lacks Dev Box's core experience of quickly spinning up and switching between project-specific development environments.

**W365 Swap** bridges that gap by orchestrating W365 snapshot, export, import, and multi-CPC switching APIs into a cohesive environment management workflow.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   W365 Swap CLI                     │
│         PowerShell Module (W365Swap.psm1)           │
├──────────┬──────────┬───────────┬───────────────────┤
│  Switch  │  Export  │  Import   │  Snapshot         │
│  (instant│  (VHD →  │  (Storage │  (Checkpoint      │
│  between │  Azure   │  → new    │   current         │
│  active  │  Storage)│  CPC)     │   state)          │
│  CPCs)   │         │           │                    │
├──────────┴──────────┴───────────┴───────────────────┤
│              Microsoft Graph Beta API               │
│    /deviceManagement/virtualEndpoint/cloudPCs/*      │
├─────────────────────────────────────────────────────┤
│                Azure Infrastructure                  │
│   Storage Account (hot/cool/archive VHD tiers)      │
└─────────────────────────────────────────────────────┘
```

### Approach

| Mode | Speed | Use Case |
|---|---|---|
| **Switch** (multi-CPC) | ~seconds | Active projects — user has 2-3 pre-provisioned CPCs |
| **Snapshot/Restore** | 5-15 min | Rollback to a checkpoint on the same CPC |
| **Export/Import** | 20-60 min | Archive/restore dormant project environments as VHDs |

## Prerequisites

- PowerShell 7+
- Azure CLI 2.50+
- Microsoft Graph PowerShell SDK (optional, uses REST directly)
- An Entra ID App Registration with `CloudPC.ReadWrite.All` permissions
- Windows 365 Enterprise licenses
- An Azure subscription for VHD storage

## Quick Start

```powershell
# 1. Deploy storage infrastructure
cd infrastructure
Copy-Item ..\. env.example ..\.env
# Edit .env with your values
.\deploy.ps1

# 2. Import the module
Import-Module .\src\W365Swap.psd1

# 3. Connect
Connect-W365Swap -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID

# 4. List environments for a user
Get-W365CloudPC -UserPrincipalName "developer@contoso.com"

# 5. Snapshot current state
New-W365Snapshot -CloudPcId "<id>" -Label "pre-refactor"

# 6. Export environment to storage for archival
Export-W365Environment -CloudPcId "<id>" -ProjectName "project-alpha"

# 7. Import archived environment
Import-W365Environment -ProjectName "project-alpha" -UserId "<userId>"

# 8. Check operation status
Get-W365SwapStatus -OperationId "<id>"
```

## Project Structure

```
w365-swap/
├── infrastructure/          # Bicep IaC for Azure Storage
│   ├── main.bicep
│   ├── main.bicepparam
│   ├── modules/
│   │   └── storageAccount.bicep
│   ├── deploy.ps1
│   └── validate.ps1
├── src/
│   ├── W365Swap.psm1        # Module loader
│   ├── W365Swap.psd1        # Module manifest
│   ├── functions/           # Public cmdlets
│   └── helpers/             # Internal utilities
├── config/
│   └── environments.json.example
└── tests/
    └── W365Swap.Tests.ps1
```

## Known Limitations

- All Graph APIs used are **beta** — no production SLA
- `importSnapshot` provisions a **new** Cloud PC (15-45 min), not a disk swap
- Cross-CPC snapshot restore is not possible (CPC A cannot use CPC B's snapshot)
- Custom images require sysprep — user state is destroyed
- Each active Cloud PC requires its own W365 Enterprise license
- VHD cross-spec portability (e.g., 8vCPU export → 4vCPU import) is untested

## License

MIT
