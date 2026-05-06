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
│   │  (tiles) │ (create/ │  (VHD →   │  (restore  │  │
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

- [Azure Developer CLI (`azd`)](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) 1.9+
- PowerShell 7+
- Node.js 20+
- Azure CLI 2.50+
- An Azure subscription with permissions to create resources
- Windows 365 Enterprise licenses (for actual Cloud PCs)

## Quick Start — Deploy Everything

```powershell
# 1. Login to Azure
azd auth login

# 2. Create an environment and deploy (infra + code)
azd up
```

That's it. `azd up` will:
1. **Pre-provision hook** → create the Entra ID app registration, API permissions, SPA platform, exposed API scope, and client secret
2. **Provision** → deploy all Azure infrastructure (resource group, storage account, Key Vault, Functions App, Static Web App, RBAC)
3. **Post-provision hook** → patch the SPA redirect URI with the production SWA URL, assign storage RBAC to the Function App identity, write local dev config files
4. **Deploy** → build and deploy the API + frontend

> **Note**: If you're not a Global/Application Administrator in Entra ID, an admin must grant consent for `CloudPC.ReadWrite.All` in the Azure Portal after the first deploy.

### Set up CI/CD

```powershell
azd pipeline config
```

Creates a GitHub Actions workflow with federated credentials. After this, `git push` to `main` triggers automatic deployment.

### Tear down

```powershell
azd down
```

### Multiple environments

```powershell
azd env new staging
azd up              # deploys isolated staging environment
```

## Quick Start — CLI Only

The PowerShell module can be used standalone without the portal:

```powershell
# 1. Import the module
Import-Module .\src\W365Swap.psd1

# 2. Connect (interactive device code flow)
Connect-W365Swap -TenantId $env:TENANT_ID -ClientId $env:CLIENT_ID -DeviceCode

# 3. List environments for a user
Get-W365CloudPC -UserPrincipalName "developer@contoso.com"

# 4. Snapshot current state
New-W365Snapshot -CloudPcId "<id>" -Label "pre-refactor"

# 5. Export environment to storage for archival
Export-W365Environment -CloudPcId "<id>" -ProjectName "project-alpha" -StorageAccountId "<storageId>"

# 6. Import an archived environment (look up the actual container + blob name first;
#    Windows 365 writes to a service-managed `windows365-share-ent-*` container)
Import-W365Environment -UserId "<userId>" -StorageAccountId "<storageId>" `
    -ContainerName "windows365-share-ent-<suffix>" `
    -BlobName "CPC_<cloudPcId>_<guid>.vhd"

# 7. Check operation status
Get-W365SwapStatus -OperationId "<id>"
```

## Local Development

After `azd up`, local dev config files are generated automatically:

```powershell
# Portal frontend
cd portal/web && npm install && npm run dev
# Open http://localhost:3000

# API backend (separate terminal)
cd portal/api && npm install && npm start
```

## Project Structure

```
w365-swap/
├── azure.yaml                   # Azure Developer CLI manifest
├── infra/                       # Consolidated Bicep IaC (azd convention)
│   ├── main.bicep               #   Subscription-scoped orchestrator
│   ├── main.parameters.json     #   Parameter bindings from azd env
│   └── modules/
│       ├── storage-account.bicep #  Storage + lifecycle tiering
│       └── portal.bicep          #  Key Vault + Functions + SWA
├── scripts/                     # azd hook scripts
│   ├── entra-app.ps1            #   Pre-provision: Entra ID app registration
│   └── post-provision.ps1       #   Post-provision: redirect URI + RBAC + local config
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
│   │           ├── types.ts         # Shared TypeScript types
│   │           └── validation.ts    # Input validation helpers
│   ├── web/                     # Next.js frontend
│   │   ├── package.json
│   │   ├── staticwebapp.config.json
│   │   └── src/
│   │       ├── app/             # Next.js App Router pages
│   │       ├── components/      # React components
│   │       └── lib/
│   │           ├── api-client.ts    # Fetch wrapper for API calls
│   │           └── msal-config.ts   # MSAL.js auth configuration
├── src/                         # PowerShell CLI module
│   ├── W365Swap.psm1
│   ├── W365Swap.psd1
│   ├── functions/               # 7 public cmdlets
│   └── helpers/
│       ├── GraphApi.ps1         # Token cache + Graph REST
│       └── StateManager.ps1     # Local JSON operation log
├── tests/
│   └── W365Swap.Tests.ps1      # Pester v3 tests
├── .env.example                 # CLI-only environment template
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
