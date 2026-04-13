# W365 Swap

Orchestration toolkit for switching between pre-configured development environments on Windows 365 Cloud PCs. Built as an alternative for organizations transitioning from Microsoft Dev Box.

> **Warning**: This project uses Microsoft Graph **beta** APIs which are subject to change and not supported for production use. Test thoroughly in a lab environment first.

## Problem

Microsoft Dev Box stopped accepting new customers on November 1, 2025, with capabilities being integrated into Windows 365. However, W365 currently lacks Dev Box's core experience of quickly spinning up and switching between project-specific development environments.

**W365 Swap** bridges that gap by providing:
- A **self-service web portal** (modeled after the Dev Box developer portal) where users manage their Cloud PC environments
- A **PowerShell CLI** for admin/automation workflows
- **Azure Functions API** backend connecting both interfaces to the Microsoft Graph Beta API

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Web Portal (Next.js)               │
│            Azure Static Web Apps + MSAL.js          │
│   ┌──────────┬──────────┬───────────┬────────────┐  │
│   │  Switch  │ Snapshot │  Export   │  Import    │  │
│   │  (tiles) │ (create/ │  (VHD →  │  (restore  │  │
│   │          │  restore)│  archive) │  from VHD) │  │
│   └──────────┴──────────┴───────────┴────────────┘  │
├─────────────────────────────────────────────────────┤
│             Azure Functions API (Node.js)           │
│    /api/cloudpcs  /api/snapshots  /api/environments │
├─────────────────────────────────────────────────────┤
│           PowerShell CLI (W365Swap.psm1)            │
│         Admin automation & scripted workflows       │
├─────────────────────────────────────────────────────┤
│              Microsoft Graph Beta API               │
│    /deviceManagement/virtualEndpoint/cloudPCs/*     │
├─────────────────────────────────────────────────────┤
│                Azure Infrastructure                 │
│   Storage Account (hot/cool/archive VHD tiers)      │
│   Static Web App + Functions App                    │
└─────────────────────────────────────────────────────┘
```

### How It Compares to Dev Box

| Feature | Dev Box Portal | W365 Swap Portal |
|---|---|---|
| Self-service tile cards | Per Dev Box with status | Per Cloud PC with project label |
| Create new environment | From pool + image | Import VHD or assign new CPC |
| Snapshot / Restore | Restore points | `createSnapshot` / `restore` API |
| Connect action | RDP / browser | W365 Switch, Boot, or web client |
| Archive / Delete | Delete Dev Box | Export VHD to cold storage |
| Authentication | Entra ID | MSAL.js + Entra ID |

### Approach

| Mode | Speed | Use Case |
|---|---|---|
| **Switch** (multi-CPC) | ~seconds | Active projects — user has 2-3 pre-provisioned CPCs |
| **Snapshot/Restore** | 5-15 min | Rollback to a checkpoint on the same CPC |
| **Export/Import** | 20-60 min | Archive/restore dormant project environments as VHDs |

## Prerequisites

### CLI (PowerShell module)

- PowerShell 7+
- Azure CLI 2.50+
- An Entra ID App Registration with `CloudPC.ReadWrite.All` permissions
- Windows 365 Enterprise licenses
- An Azure subscription for VHD storage

### Web Portal

- Node.js 18+
- An Entra ID App Registration with a SPA redirect URI
- Azure Static Web Apps (for hosting)
- Azure Functions (for API backend)

## Quick Start — CLI

```powershell
# 1. Deploy storage infrastructure
cd infrastructure
Copy-Item ..\.env.example ..\.env
# Edit .env with your values
.\deploy.ps1

# 2. Import the module
Import-Module .\src\W365Swap.psd1

# 3. Connect
Connect-W365Swap -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID -DeviceCode

# 4. List environments for a user
Get-W365CloudPC -UserPrincipalName "developer@contoso.com"

# 5. Snapshot current state
New-W365Snapshot -CloudPcId "<id>" -Label "pre-refactor"

# 6. Export environment to storage for archival
Export-W365Environment -CloudPcId "<id>" -ProjectName "project-alpha" -StorageAccountId "<storageId>"

# 7. Import archived environment
Import-W365Environment -ProjectName "project-alpha" -UserId "<userId>" -StorageAccountId "<storageId>"

# 8. Check operation status
Get-W365SwapStatus -OperationId "<id>"
```

## Quick Start — Web Portal

```bash
# 1. Configure environment
cd portal
cp .env.example .env
# Edit .env with your Entra ID app registration values

# 2. Install API dependencies
cd api && npm install && cd ..

# 3. Install web dependencies
cd web && npm install && cd ..

# 4. Run API locally
cd api && npm start &

# 5. Run web locally
cd web && npm run dev
# Open http://localhost:3000
```

### Portal Entra ID App Registration

Register an app in Entra ID with the following settings:

1. **Authentication** → Add SPA platform → Redirect URI: `http://localhost:3000` (dev) / your SWA URL (prod)
2. **API Permissions** → Add `CloudPC.ReadWrite.All` (delegated) and `User.Read`
3. Copy the **Application (client) ID** and **Directory (tenant) ID** to `portal/.env`

## Project Structure

```
w365-swap/
├── infrastructure/              # Bicep IaC for VHD storage
│   ├── main.bicep
│   ├── main.bicepparam
│   ├── modules/
│   │   └── storageAccount.bicep
│   ├── deploy.ps1
│   └── validate.ps1
├── portal/                      # Self-service web portal
│   ├── .env.example
│   ├── api/                     # Azure Functions API backend
│   │   ├── host.json
│   │   ├── package.json
│   │   └── src/
│   │       ├── functions/       # HTTP trigger endpoints
│   │       │   ├── cloudpcs.ts      # GET /api/cloudpcs
│   │       │   ├── snapshots.ts     # GET/POST /api/snapshots
│   │       │   ├── actions.ts       # POST /api/actions
│   │       │   └── environments.ts  # GET/POST /api/environments
│   │       └── lib/
│   │           ├── graph-client.ts  # OBO token + Graph REST calls
│   │           └── types.ts         # Shared TypeScript types
│   ├── web/                     # Next.js frontend
│   │   ├── package.json
│   │   ├── staticwebapp.config.json
│   │   └── src/
│   │       ├── app/             # Next.js App Router pages
│   │       │   ├── layout.tsx
│   │       │   └── page.tsx
│   │       ├── components/      # React components
│   │       │   ├── AuthProvider.tsx
│   │       │   ├── CloudPCCard.tsx      # Per-CPC tile card
│   │       │   ├── CloudPCDashboard.tsx # Main dashboard grid
│   │       │   └── SnapshotPanel.tsx    # Snapshot list + actions
│   │       └── lib/
│   │           ├── api-client.ts    # Fetch wrapper for API calls
│   │           └── msal-config.ts   # MSAL.js auth configuration
│   └── infrastructure/          # Bicep for SWA + Functions
│       └── main.bicep
├── src/                         # PowerShell CLI module
│   ├── W365Swap.psm1
│   ├── W365Swap.psd1
│   ├── functions/               # 9 public cmdlets
│   │   ├── Connect-W365Swap.ps1
│   │   ├── Get-W365CloudPC.ps1
│   │   ├── New-W365Snapshot.ps1
│   │   ├── Export-W365Environment.ps1
│   │   ├── Import-W365Environment.ps1
│   │   ├── Switch-W365Environment.ps1
│   │   ├── Restore-W365Environment.ps1
│   │   ├── Get-W365SwapStatus.ps1
│   │   └── Remove-W365ArchivedEnvironment.ps1
│   └── helpers/
│       ├── GraphApi.ps1         # Token cache + Graph REST
│       └── StateManager.ps1     # Local JSON state tracking
├── config/
│   └── environments.json.example
├── tests/
│   └── W365Swap.Tests.ps1      # Pester v3 tests (10 passing)
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## Known Limitations

- All Graph APIs used are **beta** — no production SLA
- `importSnapshot` provisions a **new** Cloud PC (15-45 min), not a disk swap
- Cross-CPC snapshot restore is not possible (CPC A cannot use CPC B's snapshot)
- Custom images require sysprep — user state is destroyed
- Each active Cloud PC requires its own W365 Enterprise license
- VHD cross-spec portability (e.g., 8vCPU export → 4vCPU import) is untested
- Portal uses On-Behalf-Of (OBO) flow — requires Entra ID app with `CloudPC.ReadWrite.All` delegated permission

## License

MIT
