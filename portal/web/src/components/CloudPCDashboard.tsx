"use client";

import { useMsal } from "@azure/msal-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cloudPcApi } from "@/lib/api-client";

/* =========================================================================
 * Constants & local-storage helpers
 * ========================================================================= */

const STORAGE_ACCOUNT_ID = process.env.NEXT_PUBLIC_STORAGE_ACCOUNT_ID || "";
const PENDING_SWAPS_STORAGE_KEY = "w365swap.pendingSwaps";
// Drop pending entries after 3h — real exports complete well within that.
const PENDING_TTL_MS = 3 * 60 * 60 * 1000;

type PendingSwap = {
  projectName: string;
  cloudPcId: string;
  cloudPcName: string;
  startedAt: string; // ISO
};

function loadPending(): PendingSwap[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PENDING_SWAPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingSwap[];
    const cutoff = Date.now() - PENDING_TTL_MS;
    return parsed.filter((p) => new Date(p.startedAt).getTime() >= cutoff);
  } catch {
    return [];
  }
}

function savePending(list: PendingSwap[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_SWAPS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota errors */
  }
}

/* =========================================================================
 * Main dashboard
 * ========================================================================= */

export function CloudPCDashboard() {
  const { instance } = useMsal();

  const [cloudPCs, setCloudPCs] = useState<any[]>([]);
  const [swaps, setSwaps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [swapsLoading, setSwapsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);

  const [saveDialog, setSaveDialog] = useState<{ cpc: any } | null>(null);
  const [restoreDialog, setRestoreDialog] = useState<{ cpc: any } | null>(null);
  const [provisionDialog, setProvisionDialog] = useState<{ swap: any } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ swap: any } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ swap: any } | null>(null);

  const [busyCpc, setBusyCpc] = useState<string | null>(null);
  const [busySwap, setBusySwap] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error" | "info"; msg: string } | null>(null);

  /* ------------------------------------------------------------------ */
  /* Data loaders                                                        */
  /* ------------------------------------------------------------------ */

  const loadCloudPCs = useCallback(async () => {
    try {
      setError(null);
      const data = await cloudPcApi.list(instance);
      setCloudPCs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [instance]);

  const loadSwaps = useCallback(async () => {
    try {
      const data = await cloudPcApi.listSwaps(instance);

      // Reconcile any pending exports in localStorage against the freshly
      // loaded swap list: if a pending export's CPC id now appears in a VHD
      // blob name and that blob has no displayName yet, persist the user-
      // supplied projectName onto the blob as metadata, then drop the pending
      // row. Runs inline (not in a useEffect) to avoid closure races.
      const pendingNow = loadPending();
      if (pendingNow.length > 0 && Array.isArray(data) && data.length > 0) {
        const completed: PendingSwap[] = [];
        for (const p of pendingNow) {
          const swap = data.find(
            (s: any) =>
              typeof s?.name === "string" &&
              s.name.toLowerCase().includes(p.cloudPcId.toLowerCase()),
          );
          if (!swap) continue;
          completed.push(p);
          if (!swap.displayName && p.projectName) {
            try {
              await cloudPcApi.renameSwap(
                instance,
                swap.containerName,
                swap.name,
                p.projectName,
              );
              swap.displayName = p.projectName; // reflect locally so UI updates immediately
            } catch (err) {
              console.warn("Failed to persist pending displayName:", err);
            }
          }
        }
        if (completed.length > 0) {
          const doneNames = new Set(completed.map((c) => c.projectName));
          setPendingSwaps((prev) => prev.filter((p) => !doneNames.has(p.projectName)));
        }
      }

      setSwaps(data);
    } catch (err: any) {
      console.error("Failed to load swaps:", err);
      setSwaps([]);
    } finally {
      setSwapsLoading(false);
    }
  }, [instance]);

  useEffect(() => {
    loadCloudPCs();
    loadSwaps();
    setPendingSwaps(loadPending());
  }, [loadCloudPCs, loadSwaps]);

  useEffect(() => savePending(pendingSwaps), [pendingSwaps]);

  /* Auto-poll while an export is in flight. */
  useEffect(() => {
    if (pendingSwaps.length === 0) return;
    const interval = setInterval(() => loadSwaps(), 30_000);
    return () => clearInterval(interval);
  }, [pendingSwaps.length, loadSwaps]);

  /* ------------------------------------------------------------------ */
  /* Action handlers                                                     */
  /* ------------------------------------------------------------------ */

  const showToast = (kind: "success" | "error" | "info", msg: string) => {
    setToast({ kind, msg });
    window.setTimeout(() => setToast(null), 6000);
  };

  async function handleSaveSwap(cpc: any, projectName: string, accessTier: "hot" | "cool" | "cold" | "archive") {
    setBusyCpc(cpc.id);
    try {
      await cloudPcApi.saveSwap(instance, {
        cloudPcId: cpc.id,
        projectName,
        storageAccountId: STORAGE_ACCOUNT_ID,
        accessTier,
      });
      setPendingSwaps((prev) => [
        {
          projectName,
          cloudPcId: cpc.id,
          cloudPcName: cpc.displayName || cpc.id,
          startedAt: new Date().toISOString(),
        },
        ...prev.filter((p) => p.projectName !== projectName),
      ]);
      setSaveDialog(null);
      showToast("success", `Exporting "${projectName}" — typically 20–60 min.`);
    } catch (err: any) {
      showToast("error", `Save failed: ${err.message}`);
    } finally {
      setBusyCpc(null);
    }
  }

  async function handleRestore(cpc: any, snapshotId: string) {
    setBusyCpc(cpc.id);
    try {
      await cloudPcApi.restoreCloudPc(instance, cpc.id, snapshotId);
      setRestoreDialog(null);
      showToast("success", `Restoring ${cpc.displayName}. Unavailable for ~5–15 min.`);
      loadCloudPCs();
    } catch (err: any) {
      showToast("error", `Restore failed: ${err.message}`);
    } finally {
      setBusyCpc(null);
    }
  }

  async function handleRenameSwap(swap: any, displayName: string) {
    setBusySwap(swap.name);
    try {
      await cloudPcApi.renameSwap(instance, swap.containerName, swap.name, displayName);
      setRenameDialog(null);
      showToast("success", "Renamed.");
      loadSwaps();
    } catch (err: any) {
      showToast("error", `Rename failed: ${err.message}`);
    } finally {
      setBusySwap(null);
    }
  }

  async function handleDeleteSwap(swap: any) {
    setBusySwap(swap.name);
    try {
      await cloudPcApi.deleteSwap(instance, swap.containerName, swap.name);
      setDeleteDialog(null);
      showToast("success", "Swap deleted.");
      loadSwaps();
    } catch (err: any) {
      showToast("error", `Delete failed: ${err.message}`);
    } finally {
      setBusySwap(null);
    }
  }

  async function handleProvisionFromSwap(swap: any) {
    const userId = instance.getActiveAccount()?.localAccountId;
    if (!userId) {
      showToast("error", "Cannot determine user ID. Sign out and back in.");
      return;
    }
    setBusySwap(swap.name);
    try {
      await cloudPcApi.provisionFromSwap(instance, {
        userId,
        storageAccountId: STORAGE_ACCOUNT_ID,
        blobName: swap.name,
        containerName: swap.containerName,
      });
      setProvisionDialog(null);
      showToast("success", "Provisioning new Cloud PC — typically 15–45 min.");
      loadCloudPCs();
    } catch (err: any) {
      showToast("error", `Provisioning failed: ${err.message}`);
    } finally {
      setBusySwap(null);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-medium">Failed to load Cloud PCs</h3>
        <p className="text-red-600 text-sm mt-1">{error}</p>
        <button onClick={loadCloudPCs} className="mt-3 text-sm text-red-700 underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ExplainerBanner />

      {/* --- Cloud PCs --- */}
      <section>
        <SectionHeader
          title="Your Cloud PCs"
          subtitle="Save the current state to storage, or restore to a previous in-service snapshot."
          onRefresh={() => {
            loadCloudPCs();
            loadSwaps();
          }}
        />

        {cloudPCs.length === 0 ? (
          <EmptyCard>No Cloud PCs assigned to your account.</EmptyCard>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {cloudPCs.map((cpc) => (
              <CloudPcCard
                key={cpc.id}
                cpc={cpc}
                busy={busyCpc === cpc.id}
                onSave={() => setSaveDialog({ cpc })}
                onRestore={() => setRestoreDialog({ cpc })}
              />
            ))}
          </div>
        )}
      </section>

      {/* --- Saved Swaps --- */}
      <section>
        <SectionHeader
          title="Saved Swaps"
          subtitle="Exported environments stored in your storage account. Provision a new Cloud PC from any swap."
        />

        {swapsLoading && pendingSwaps.length === 0 && swaps.length === 0 ? (
          <div className="text-gray-500 text-sm py-4">Loading saved swaps...</div>
        ) : swaps.length === 0 && pendingSwaps.length === 0 ? (
          <EmptyCard>No saved swaps yet. Choose &quot;Save&quot; on a Cloud PC to get started.</EmptyCard>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-gray-500">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Size</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Tier</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingSwaps.map((p) => (
                  <PendingSwapRow
                    key={`pending-${p.projectName}-${p.startedAt}`}
                    pending={p}
                    onDismiss={() =>
                      setPendingSwaps((prev) => prev.filter((x) => x.projectName !== p.projectName))
                    }
                  />
                ))}
                {swaps.map((swap) => (
                  <SwapRow
                    key={swap.name}
                    swap={swap}
                    cloudPCs={cloudPCs}
                    busy={busySwap === swap.name}
                    onProvision={() => setProvisionDialog({ swap })}
                    onRename={() => setRenameDialog({ swap })}
                    onDelete={() => setDeleteDialog({ swap })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --- Dialogs --- */}
      {saveDialog && (
        <SaveSwapDialog
          cpc={saveDialog.cpc}
          busy={busyCpc === saveDialog.cpc.id}
          onCancel={() => setSaveDialog(null)}
          onConfirm={(name, tier) => handleSaveSwap(saveDialog.cpc, name, tier)}
        />
      )}
      {restoreDialog && (
        <RestoreDialog
          cpc={restoreDialog.cpc}
          busy={busyCpc === restoreDialog.cpc.id}
          onCancel={() => setRestoreDialog(null)}
          onConfirm={(snapshotId) => handleRestore(restoreDialog.cpc, snapshotId)}
        />
      )}
      {provisionDialog && (
        <ProvisionDialog
          swap={provisionDialog.swap}
          cloudPCs={cloudPCs}
          busy={busySwap === provisionDialog.swap.name}
          onCancel={() => setProvisionDialog(null)}
          onConfirm={() => handleProvisionFromSwap(provisionDialog.swap)}
        />
      )}
      {renameDialog && (
        <RenameSwapDialog
          swap={renameDialog.swap}
          cloudPCs={cloudPCs}
          busy={busySwap === renameDialog.swap.name}
          onCancel={() => setRenameDialog(null)}
          onConfirm={(name) => handleRenameSwap(renameDialog.swap, name)}
        />
      )}
      {deleteDialog && (
        <DeleteSwapDialog
          swap={deleteDialog.swap}
          cloudPCs={cloudPCs}
          busy={busySwap === deleteDialog.swap.name}
          onCancel={() => setDeleteDialog(null)}
          onConfirm={() => handleDeleteSwap(deleteDialog.swap)}
        />
      )}

      {toast && <Toast kind={toast.kind} msg={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
}

/* =========================================================================
 * Small helpers & formatters
 * ========================================================================= */

function friendlyName(swapOrBlobName: any, cloudPCs: any[]): string {
  // Accept either a swap object (with optional displayName) or a raw blob name.
  if (typeof swapOrBlobName === "object" && swapOrBlobName !== null) {
    if (typeof swapOrBlobName.displayName === "string" && swapOrBlobName.displayName.trim()) {
      return swapOrBlobName.displayName;
    }
    return friendlyName(swapOrBlobName.name ?? "", cloudPCs);
  }
  const blobName = String(swapOrBlobName ?? "");
  const base = blobName.replace(/^.*\//, "").replace(/\.(vhdx?|vmgs)$/i, "");
  const match = base.match(/^CPC_([0-9a-f-]{36})_/i);
  if (match) {
    const cpc = cloudPCs.find((c) => c.id?.toLowerCase() === match[1].toLowerCase());
    if (cpc?.displayName) return cpc.displayName;
  }
  return base;
}

function formatSize(bytes: number) {
  if (!bytes) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* =========================================================================
 * Sub-components
 * ========================================================================= */

function ExplainerBanner() {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1 text-sm">
          <p className="font-semibold text-gray-900">Three things you can do here</p>
          <ul className="mt-1.5 space-y-1 text-gray-600 text-xs">
            <li>
              <strong className="text-gray-800">Save</strong> — exports a Cloud PC&apos;s current state to your
              storage account as a durable VHD (20–60 min).
            </li>
            <li>
              <strong className="text-gray-800">Restore</strong> — rolls a Cloud PC back in place to one of
              its own in-service snapshots. Fast (5–15 min), same device, same license.
            </li>
            <li>
              <strong className="text-gray-800">Provision new from swap</strong> — creates a brand-new Cloud
              PC from a saved swap. Useful for cloning or recovering after the in-service snapshot window.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  onRefresh,
}: {
  title: string;
  subtitle: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      {onRefresh && (
        <button
          onClick={onRefresh}
          className="text-xs bg-white border border-gray-300 px-3 py-1.5 rounded-md hover:bg-gray-50"
        >
          Refresh
        </button>
      )}
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 border-dashed p-8 text-center text-gray-500 text-sm">
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const running = ["provisioned", "running"].includes(status);
  const danger = ["failed", "notProvisioned"].includes(status);
  const bg = running
    ? "bg-green-50 text-green-700"
    : danger
      ? "bg-red-50 text-red-700"
      : "bg-gray-100 text-gray-600";
  const dot = running ? "bg-green-500" : danger ? "bg-red-500" : "bg-gray-400";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  );
}

function CloudPcCard({
  cpc,
  busy,
  onSave,
  onRestore,
}: {
  cpc: any;
  busy: boolean;
  onSave: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 truncate">{cpc.displayName}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <StatusBadge status={cpc.status} />
            {cpc.servicePlanName && <span className="text-xs text-gray-400">{cpc.servicePlanName}</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onSave}
          disabled={busy}
          className="flex-1 bg-blue-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Save"}
        </button>
        <button
          onClick={onRestore}
          disabled={busy}
          className="flex-1 bg-white border border-gray-300 text-gray-800 text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Restore
        </button>
      </div>
    </div>
  );
}

function PendingSwapRow({ pending, onDismiss }: { pending: PendingSwap; onDismiss: () => void }) {
  return (
    <tr className="border-b border-gray-100 last:border-0 bg-blue-50/40">
      <td className="px-4 py-3 font-medium text-gray-900">
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          {pending.projectName}
        </div>
        <div className="text-xs text-gray-400 font-normal truncate max-w-xs">
          Exporting from {pending.cloudPcName}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-500 italic">—</td>
      <td className="px-4 py-3 text-gray-600">{formatDate(pending.startedAt)}</td>
      <td className="px-4 py-3">
        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Exporting</span>
      </td>
      <td className="px-4 py-3 text-right">
        <span className="text-xs text-gray-500">typically 20–60 min</span>
        <button
          onClick={onDismiss}
          className="ml-3 text-xs text-gray-400 hover:text-gray-600 underline"
          title="Dismiss this indicator (does not cancel the export)"
        >
          Dismiss
        </button>
      </td>
    </tr>
  );
}

function SwapRow({
  swap,
  cloudPCs,
  busy,
  onProvision,
  onRename,
  onDelete,
}: {
  swap: any;
  cloudPCs: any[];
  busy: boolean;
  onProvision: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
      <td className="px-4 py-3 font-medium text-gray-900">
        {friendlyName(swap, cloudPCs)}
        <div className="text-xs text-gray-400 font-normal truncate max-w-xs">{swap.name}</div>
      </td>
      <td className="px-4 py-3 text-gray-600">{formatSize(swap.size)}</td>
      <td className="px-4 py-3 text-gray-600">{formatDate(swap.createdOn)}</td>
      <td className="px-4 py-3">
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{swap.accessTier || "—"}</span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-2">
          <button
            onClick={onRename}
            disabled={busy}
            className="text-xs text-gray-600 hover:text-gray-900 underline disabled:opacity-50"
            title="Rename this swap"
          >
            Rename
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50"
            title="Delete this swap"
          >
            Delete
          </button>
          <button
            onClick={onProvision}
            disabled={busy}
            className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? "Working…" : "Provision new Cloud PC"}
          </button>
        </div>
      </td>
    </tr>
  );
}

/* =========================================================================
 * Dialogs
 * ========================================================================= */

function DialogShell({
  title,
  subtitle,
  onClose,
  disabled,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-30" onClick={disabled ? undefined : onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-40 px-4">
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </>
  );
}

function SaveSwapDialog({
  cpc,
  busy,
  onCancel,
  onConfirm,
}: {
  cpc: any;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (name: string, tier: "hot" | "cool" | "cold" | "archive") => void;
}) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<"hot" | "cool" | "cold" | "archive">("hot");

  return (
    <DialogShell
      title="Save"
      subtitle={`Export ${cpc.displayName} to blob storage as a persistent VHD.`}
      onClose={onCancel}
      disabled={busy}
    >
      <label className="block text-sm font-medium text-gray-700 mb-1">Swap name</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. project-alpha-sprint-3"
        maxLength={200}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
        autoFocus
        disabled={busy}
      />
      <p className="text-xs text-gray-400 mt-1">
        Shown in the Saved Swaps list. You can rename it later.
      </p>

      <label className="block text-sm font-medium text-gray-700 mt-4 mb-1">Storage tier</label>
      <select
        value={tier}
        onChange={(e) => setTier(e.target.value as typeof tier)}
        disabled={busy}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white"
      >
        <option value="hot">Hot — fastest load, highest cost</option>
        <option value="cool">Cool — cheaper, slight rehydrate delay</option>
        <option value="cold">Cold — cheapest online tier</option>
        <option value="archive">Archive — cheapest, hours to rehydrate</option>
      </select>
      <p className="text-xs text-gray-400 mt-1">Typically takes 20–60 min to complete.</p>

      <div className="flex justify-end gap-2 mt-6">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(name.trim(), tier)}
          disabled={!name.trim() || busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Save"}
        </button>
      </div>
    </DialogShell>
  );
}

function RestoreDialog({
  cpc,
  busy,
  onCancel,
  onConfirm,
}: {
  cpc: any;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (snapshotId: string) => void;
}) {
  const { instance } = useMsal();
  const [snapshots, setSnapshots] = useState<any[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<any | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await cloudPcApi.listSnapshots(instance, cpc.id);
        const ready = (data || []).filter((s: any) => !s.status || s.status === "ready");
        // Newest first
        ready.sort(
          (a: any, b: any) =>
            new Date(b.createdDateTime || 0).getTime() - new Date(a.createdDateTime || 0).getTime(),
        );
        setSnapshots(ready);
        if (ready.length > 0) setSelected(ready[0]);
      } catch (err: any) {
        setLoadError(err.message || "Failed to load snapshots.");
        setSnapshots([]);
      }
    })();
  }, [instance, cpc.id]);

  return (
    <DialogShell
      title={`Restore ${cpc.displayName}`}
      subtitle="Rolls this Cloud PC back in place. Same device, same license — only the disk state changes."
      onClose={onCancel}
      disabled={busy}
    >
      <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800 mb-4">
        <strong>Any changes made since the chosen snapshot will be lost.</strong> The user will be
        disconnected; the Cloud PC is unavailable for ~5–15 min.
      </div>

      {snapshots === null ? (
        <div className="text-sm text-gray-500">Loading snapshots…</div>
      ) : loadError ? (
        <div className="text-sm text-red-600">{loadError}</div>
      ) : snapshots.length === 0 ? (
        <div className="text-sm text-gray-500">
          No in-service snapshots found. Windows 365 takes these automatically; they&apos;re retained for a
          limited window (usually days). If you need long-term recovery, use <strong>Save</strong> to
          export the current state to your storage account.
        </div>
      ) : (
        <>
          <label className="block text-sm font-medium text-gray-700 mb-1">Choose snapshot</label>
          <div className="max-h-64 overflow-auto border border-gray-200 rounded-md divide-y">
            {snapshots.map((s) => (
              <label
                key={s.id}
                className={`flex items-start gap-2 p-3 text-sm cursor-pointer hover:bg-gray-50 ${
                  selected?.id === s.id ? "bg-blue-50" : ""
                }`}
              >
                <input
                  type="radio"
                  name="snapshot"
                  checked={selected?.id === s.id}
                  onChange={() => setSelected(s)}
                  className="mt-0.5"
                  disabled={busy}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900">
                    {formatDate(s.createdDateTime || s.lastRestoredDateTime || "")}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {s.snapshotType || "automatic"}
                    {s.healthCheckStatus ? ` · ${s.healthCheckStatus}` : ""}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 mt-6">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={() => selected && onConfirm(selected.id)}
          disabled={!selected || busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Restoring…" : "Restore to this snapshot"}
        </button>
      </div>
    </DialogShell>
  );
}

function ProvisionDialog({
  swap,
  cloudPCs,
  busy,
  onCancel,
  onConfirm,
}: {
  swap: any;
  cloudPCs: any[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const name = useMemo(() => friendlyName(swap, cloudPCs), [swap, cloudPCs]);
  return (
    <DialogShell
      title="Provision new Cloud PC from swap"
      subtitle={`Creates a brand-new Cloud PC from "${name}".`}
      onClose={onCancel}
      disabled={busy}
    >
      <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800">
        A <strong>new</strong> Cloud PC will be provisioned in addition to your existing ones and assigned
        to you. It consumes one Windows 365 license. Provisioning typically takes 15–45 min.
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Provision new Cloud PC"}
        </button>
      </div>
    </DialogShell>
  );
}

function RenameSwapDialog({
  swap,
  cloudPCs,
  busy,
  onCancel,
  onConfirm,
}: {
  swap: any;
  cloudPCs: any[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const fallback = useMemo(() => friendlyName(swap, cloudPCs), [swap, cloudPCs]);
  const [name, setName] = useState<string>(swap.displayName || "");
  const canSave = name.trim().length > 0 && name.trim() !== (swap.displayName || "");
  return (
    <DialogShell
      title="Rename swap"
      subtitle="Give this swap a friendlier label. The underlying blob name stays the same."
      onClose={onCancel}
      disabled={busy}
    >
      <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={fallback}
        maxLength={200}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
        autoFocus
        disabled={busy}
      />
      <p className="text-xs text-gray-400 mt-1 truncate">Blob: {swap.name}</p>

      <div className="flex justify-end gap-2 mt-6">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(name.trim())}
          disabled={!canSave || busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save name"}
        </button>
      </div>
    </DialogShell>
  );
}

function DeleteSwapDialog({
  swap,
  cloudPCs,
  busy,
  onCancel,
  onConfirm,
}: {
  swap: any;
  cloudPCs: any[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const name = useMemo(() => friendlyName(swap, cloudPCs), [swap, cloudPCs]);
  const [confirmText, setConfirmText] = useState("");
  const canDelete = confirmText.trim().toLowerCase() === "delete";
  return (
    <DialogShell
      title="Delete swap"
      subtitle={`Permanently removes "${name}" from your storage account.`}
      onClose={onCancel}
      disabled={busy}
    >
      <div className="bg-red-50 border border-red-200 rounded-md p-3 text-xs text-red-800">
        <strong>This cannot be undone.</strong> The VHD and its guest-state companion (.vmgs) will be
        deleted. Cloud PCs you&apos;ve already provisioned from this swap are not affected.
      </div>

      <label className="block text-sm font-medium text-gray-700 mt-4 mb-1">
        Type <span className="font-mono">delete</span> to confirm
      </label>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="delete"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none"
        autoFocus
        disabled={busy}
      />
      <p className="text-xs text-gray-400 mt-1 truncate">Blob: {swap.name}</p>

      <div className="flex justify-end gap-2 mt-6">
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={!canDelete || busy}
          className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete swap"}
        </button>
      </div>
    </DialogShell>
  );
}

function Toast({
  kind,
  msg,
  onClose,
}: {
  kind: "success" | "error" | "info";
  msg: string;
  onClose: () => void;
}) {
  const styles = {
    success: "bg-emerald-600 text-white",
    error: "bg-red-600 text-white",
    info: "bg-gray-900 text-white",
  }[kind];
  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm">
      <div className={`${styles} rounded-lg shadow-lg px-4 py-3 text-sm flex items-start gap-3`}>
        <span className="flex-1">{msg}</span>
        <button onClick={onClose} className="opacity-80 hover:opacity-100">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
