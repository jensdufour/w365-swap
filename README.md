# Mosaic

> User-state vault for Windows 365.
> Save your Cloud PC session — files, settings, dev tooling — and lay it back down on whichever Cloud PC you sign into next. Works on every W365 SKU, including Frontline shared.

## Status: rebuild in progress

This repository is being rebuilt from its previous incarnation (`W365 Swap`, a Cloud PC swap/snapshot orchestrator) into **Mosaic** — a user-scoped state vault with an in-guest Rust agent, a Cosmos-backed catalog API, and customer-managed envelope encryption via Azure Key Vault.

The git history before this rename contains the previous project. The main branch will land Mosaic incrementally. Expect breaking changes during this period; nothing here is production-ready.

## Architecture (v0, design)

- **Agent** — Rust, signed MSI, deployed via Intune to every targeted Cloud PC. Captures and restores user-scope artifacts (files, registry slices, credentials, browser profiles, app inventory) on user demand or pre-sign-out.
- **Catalog API** — Azure Functions (Node 20 / TypeScript). Per-user state metadata in Cosmos DB; chunk storage in Blob via user-delegated SAS.
- **Encryption** — Envelope: per-state AES-256-GCM data key, wrapped by an HSM-backed RSA key in the **customer's** Key Vault. Mosaic's service identity never holds the key.
- **Portal** — Next.js + Azure Static Web Apps. List, capture, restore, rename, set-default.
- **Infrastructure** — Bicep, deployed via `azd up` into the customer's Azure subscription. Self-hosted by design; future Marketplace path planned.

See `docs/architecture.md` (forthcoming) for the full design.

## Local development

Once the v0 work begins, this section will document the build/run loop. Until then, the previous `W365 Swap` portal at `portal/api` and `portal/web` still builds and deploys via `azd up`, but is being decommissioned.

## License

See [LICENSE](LICENSE).
