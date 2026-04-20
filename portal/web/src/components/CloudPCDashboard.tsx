"use client";

import { useMsal } from "@azure/msal-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cloudPcApi } from "@/lib/api-client";

/* =========================================================================
 * Constants & local-storage helpers
 * ========================================================================= */

const STORAGE_ACCOUNT_ID = process.env.NEXT_PUBLIC_STORAGE_ACCOUNT_ID || "";
const PENDING_SWAPS_STORAGE_KEY = "w365swap.pendingSwaps";
const PENDING_REPLACEMENTS_STORAGE_KEY = "w365swap.pendingReplacements";
// Drop pending entries after 3h — real operations complete well within that.
const PENDING_TTL_MS = 3 * 60 * 60 * 1000;
// The replacement CTA stays visible for 48h after the new CPC is ready, so
// the user has a reasonable window to come back and confirm removal.
const REPLACEMENT_VISIBLE_TTL_MS = 48 * 60 * 60 * 1000;

type PendingSwap = {
  projectName: string;
  cloudPcId: string;
  cloudPcName: string;
  startedAt: string; // ISO
};

type PendingReplacement = {
  /** CPC id the user wants to replace — still present in their fleet until confirmed. */
  oldCloudPcId: string;
  oldCloudPcName: string;
  swapBlobName: string;
  swapFriendlyName: string;
  /** CPC IDs that existed BEFORE the import kicked off; used to detect the newly-provisioned one. */
  knownCloudPcIdsAtStart: string[];
  /** Set once we identify the replacement CPC. */
  newCloudPcId?: string;
  /** Set once newCloudPcId reports a running/provisioned state. */
  readyAt?: string; // ISO
  startedAt: string; // ISO
};

function loadJson<T>(key: string, ttlMs: number): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<T & { startedAt: string }>;
    const cutoff = Date.now() - ttlMs;
    return parsed.filter((p) => new Date(p.startedAt).getTime() >= cutoff) as T[];
  } catch {
    return [];
  }
}

function saveJson<T>(key: string, list: T[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ignore quota errors */
  }
}

/* =========================================================================
 * Main dashboard
 * ========================================================================= */

export function CloudPCDashboard() {
  const { instance } = useMsal();

  /* --- data state --- */
  const [cloudPCs, setCloudPCs] = useState<any[]>([]);
  const [swaps, setSwaps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [swapsLoading, setSwapsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* --- pending/local state --- */
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);
  const [pendingReplacements, setPendingReplacements] = useState<PendingReplacement[]>([]);

  /* --- dialog state --- */
  const [saveDialog, setSaveDialog] = useState<{ cpc: any } | null>(null);
  const [provisionDialog, setProvisionDialog] = useState<{ swap: any } | null>(null);
  const [replaceDialog, setReplaceDialog] = useState<{ cpc: any } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ cpc: any; fromReplacement?: PendingReplacement } | null>(null);

  /* --- per-action transient state --- */
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
      setSwaps(data);
    } catch (err: any) {
      // Non-fatal — CPC list is still shown.
      console.error("Failed to load swaps:", err);
      setSwaps([]);
    } finally {
      setSwapsLoading(false);
    }
  }, [instance]);

  useEffect(() => {
    loadCloudPCs();
    loadSwaps();
    setPendingSwaps(loadJson<PendingSwap>(PENDING_SWAPS_STORAGE_KEY, PENDING_TTL_MS));
    setPendingReplacements(
      loadJson<PendingReplacement>(PENDING_REPLACEMENTS_STORAGE_KEY, REPLACEMENT_VISIBLE_TTL_MS),
    );
  }, [loadCloudPCs, loadSwaps]);

  useEffect(() => saveJson(PENDING_SWAPS_STORAGE_KEY, pendingSwaps), [pendingSwaps]);
  useEffect(() => saveJson(PENDING_REPLACEMENTS_STORAGE_KEY, pendingReplacements), [pendingReplacements]);

  /* Drop pending swap rows once the completed VHD is visible.
     W365 blob names embed the source cloudPcId (CPC_<cpcId>_<guid>.vhd). */
  useEffect(() => {
    if (pendingSwaps.length === 0 || swaps.length === 0) return;
    const done = new Set(
      pendingSwaps
        .filter((p) =>
          swaps.some(
            (s: any) => typeof s.name === "string" && s.name.toLowerCase().includes(p.cloudPcId.toLowerCase()),
          ),
        )
        .map((p) => p.projectName),
    );
    if (done.size > 0) {
      setPendingSwaps((prev) => prev.filter((p) => !done.has(p.projectName)));
    }
  }, [swaps, pendingSwaps]);

  /* Identify the replacement CPC as soon as a new one appears in the fleet. */
  useEffect(() => {
    if (pendingReplacements.length === 0 || cloudPCs.length === 0) return;
    setPendingReplacements((prev) =>
      prev.map((r) => {
        if (r.newCloudPcId) {
          // Already identified — just update readyAt when it transitions to ready.
          const cpc = cloudPCs.find((c) => c.id === r.newCloudPcId);
          if (!r.readyAt && cpc && ["provisioned", "running"].includes(cpc.status)) {
            return { ...r, readyAt: new Date().toISOString() };
          }
          return r;
        }
        const knownSet = new Set(r.knownCloudPcIdsAtStart);
        const fresh = cloudPCs.find((c) => !knownSet.has(c.id) && c.id !== r.oldCloudPcId);
        if (!fresh) return r;
        const ready = ["provisioned", "running"].includes(fresh.status);
        return {
          ...r,
          newCloudPcId: fresh.id,
          readyAt: ready ? new Date().toISOString() : r.readyAt,
        };
      }),
    );
  }, [cloudPCs, pendingReplacements]);

  /* Auto-poll while anything is in flight. */
  const anythingPending = pendingSwaps.length > 0 || pendingReplacements.some((r) => !r.readyAt);
  useEffect(() => {
    if (!anythingPending) return;
    const interval = setInterval(() => {
      loadSwaps();
      loadCloudPCs();
    }, 30_000);
    return () => clearInterval(interval);
  }, [anythingPending, loadSwaps, loadCloudPCs]);

  /* ------------------------------------------------------------------ */
  /* Action handlers                                                     */
  /* ------------------------------------------------------------------ */

  const currentUserId = () => instance.getActiveAccount()?.localAccountId;

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

  async function handleProvisionFromSwap(swap: any) {
    const userId = currentUserId();
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

  async function handleReplaceFromSwap(cpc: any, swap: any) {
    const userId = currentUserId();
    if (!userId) {
      showToast("error", "Cannot determine user ID. Sign out and back in.");
      return;
    }
    setBusyCpc(cpc.id);
    try {
      await cloudPcApi.provisionFromSwap(instance, {
        userId,
        storageAccountId: STORAGE_ACCOUNT_ID,
        blobName: swap.name,
        containerName: swap.containerName,
      });
      setPendingReplacements((prev) => [
        {
          oldCloudPcId: cpc.id,
          oldCloudPcName: cpc.displayName || cpc.id,
          swapBlobName: swap.name,
          swapFriendlyName: friendlyName(swap.name, cloudPCs),
          knownCloudPcIdsAtStart: cloudPCs.map((c) => c.id),
          startedAt: new Date().toISOString(),
        },
        ...prev.filter((r) => r.oldCloudPcId !== cpc.id),
      ]);
      setReplaceDialog(null);
      showToast(
        "success",
        `Provisioning replacement for ${cpc.displayName}. You'll be asked to remove the old one once the new one is ready.`,
      );
      loadCloudPCs();
    } catch (err: any) {
      showToast("error", `Replacement start failed: ${err.message}`);
    } finally {
      setBusyCpc(null);
    }
  }

  async function handleDeleteCpc(cpc: any, fromReplacement?: PendingReplacement) {
    setBusyCpc(cpc.id);
    try {
      await cloudPcApi.deleteCloudPc(instance, cpc.id);
      if (fromReplacement) {
        setPendingReplacements((prev) => prev.filter((r) => r.oldCloudPcId !== cpc.id));
      }
      setDeleteConfirm(null);
      showToast("success", `Removing ${cpc.displayName}. It will enter grace period per tenant policy.`);
      loadCloudPCs();
    } catch (err: any) {
      showToast("error", `Delete failed: ${err.message}`);
    } finally {
      setBusyCpc(null);
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

  const readyReplacements = pendingReplacements.filter((r) => r.readyAt);
  const inFlightReplacements = pendingReplacements.filter((r) => !r.readyAt);

  return (
    <div className="space-y-6">
      {/* --- Explainer banner --- */}
      <ExplainerBanner />

      {/* --- Ready replacements CTA (top-priority action) --- */}
      {readyReplacements.map((r) => {
        const oldCpc = cloudPCs.find((c) => c.id === r.oldCloudPcId);
        const newCpc = cloudPCs.find((c) => c.id === r.newCloudPcId);
        if (!oldCpc) {
          // Old already deleted — clear the tracker.
          return null;
        }
        return (
          <div
            key={`ready-${r.oldCloudPcId}`}
            className="bg-emerald-50 border border-emerald-300 rounded-lg p-4 flex items-start gap-3"
          >
            <svg className="w-6 h-6 text-emerald-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-900">
                Replacement ready for {r.oldCloudPcName}
              </p>
              <p className="text-xs text-emerald-800 mt-0.5">
                New Cloud PC {newCpc?.displayName ? `"${newCpc.displayName}"` : "(provisioning)"} is ready from
                swap <strong>{r.swapFriendlyName}</strong>. You can remove the old one when ready.
              </p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => setDeleteConfirm({ cpc: oldCpc, fromReplacement: r })}
                  className="bg-red-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-red-700"
                >
                  Remove old Cloud PC
                </button>
                <button
                  onClick={() =>
                    setPendingReplacements((prev) => prev.filter((x) => x.oldCloudPcId !== r.oldCloudPcId))
                  }
                  className="text-sm text-emerald-800 hover:text-emerald-900 underline"
                >
                  Keep both
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* --- Cloud PCs --- */}
      <section>
        <SectionHeader
          title="Your Cloud PCs"
          subtitle="Save the current state, replace a Cloud PC's state from a saved swap, or remove it."
          onRefresh={() => {
            loadCloudPCs();
            loadSwaps();
          }}
        />

        {cloudPCs.length === 0 ? (
          <EmptyCard>No Cloud PCs assigned to your account.</EmptyCard>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {cloudPCs.map((cpc) => {
              const inFlight = inFlightReplacements.find((r) => r.oldCloudPcId === cpc.id);
              return (
                <CloudPcCard
                  key={cpc.id}
                  cpc={cpc}
                  busy={busyCpc === cpc.id}
                  inFlightReplacement={inFlight}
                  hasSwaps={swaps.length > 0}
                  onSave={() => setSaveDialog({ cpc })}
                  onReplace={() => setReplaceDialog({ cpc })}
                  onDelete={() => setDeleteConfirm({ cpc })}
                />
              );
            })}
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
          <EmptyCard>No saved swaps yet. Choose &quot;Save as swap&quot; on a Cloud PC to get started.</EmptyCard>
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
      {provisionDialog && (
        <ProvisionDialog
          swap={provisionDialog.swap}
          cloudPCs={cloudPCs}
          busy={busySwap === provisionDialog.swap.name}
          onCancel={() => setProvisionDialog(null)}
          onConfirm={() => handleProvisionFromSwap(provisionDialog.swap)}
        />
      )}
      {replaceDialog && (
        <ReplaceDialog
          cpc={replaceDialog.cpc}
          swaps={swaps}
          cloudPCs={cloudPCs}
          busy={busyCpc === replaceDialog.cpc.id}
          onCancel={() => setReplaceDialog(null)}
          onConfirm={(swap) => handleReplaceFromSwap(replaceDialog.cpc, swap)}
        />
      )}
      {deleteConfirm && (
        <DeleteConfirmDialog
          cpc={deleteConfirm.cpc}
          isReplacement={!!deleteConfirm.fromReplacement}
          busy={busyCpc === deleteConfirm.cpc.id}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => handleDeleteCpc(deleteConfirm.cpc, deleteConfirm.fromReplacement)}
        />
      )}

      {toast && <Toast kind={toast.kind} msg={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
}

/* =========================================================================
 * Small helpers & formatters
 * ========================================================================= */

function friendlyName(blobName: string, cloudPCs: any[]): string {
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
              <strong className="text-gray-800">Save as swap</strong> — exports a Cloud PC&apos;s current state to
              storage (20–60 min).
            </li>
            <li>
              <strong className="text-gray-800">Replace from swap</strong> — provisions a new Cloud PC from a
              saved swap, then removes the old one once the new is ready.
            </li>
            <li>
              <strong className="text-gray-800">Provision new from swap</strong> — creates an additional Cloud
              PC from a saved swap without touching existing ones.
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
  const deleting = ["deprovisioning", "failed", "notProvisioned"].includes(status);
  const bg = running
    ? "bg-green-50 text-green-700"
    : deleting
      ? "bg-red-50 text-red-700"
      : "bg-gray-100 text-gray-600";
  const dot = running ? "bg-green-500" : deleting ? "bg-red-500" : "bg-gray-400";
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
  hasSwaps,
  inFlightReplacement,
  onSave,
  onReplace,
  onDelete,
}: {
  cpc: any;
  busy: boolean;
  hasSwaps: boolean;
  inFlightReplacement?: PendingReplacement;
  onSave: () => void;
  onReplace: () => void;
  onDelete: () => void;
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

      {inFlightReplacement && (
        <div className="mt-3 p-2.5 rounded-md bg-blue-50 border border-blue-200 flex items-center gap-2 text-xs text-blue-800">
          <span className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          Replacement in progress from swap <strong>{inFlightReplacement.swapFriendlyName}</strong>
        </div>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onSave}
          disabled={busy}
          className="flex-1 bg-blue-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Save as swap"}
        </button>
        <button
          onClick={onReplace}
          disabled={busy || !hasSwaps || !!inFlightReplacement}
          title={!hasSwaps ? "No saved swaps yet" : inFlightReplacement ? "Replacement already in progress" : ""}
          className="flex-1 bg-white border border-gray-300 text-gray-800 text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Replace from swap
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          title="Remove this Cloud PC"
          className="px-2.5 py-2 text-gray-400 hover:text-red-600 rounded-lg border border-gray-200 hover:border-red-200 hover:bg-red-50"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M8 7V4a2 2 0 012-2h4a2 2 0 012 2v3" />
          </svg>
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
}: {
  swap: any;
  cloudPCs: any[];
  busy: boolean;
  onProvision: () => void;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
      <td className="px-4 py-3 font-medium text-gray-900">
        {friendlyName(swap.name, cloudPCs)}
        <div className="text-xs text-gray-400 font-normal truncate max-w-xs">{swap.name}</div>
      </td>
      <td className="px-4 py-3 text-gray-600">{formatSize(swap.size)}</td>
      <td className="px-4 py-3 text-gray-600">{formatDate(swap.createdOn)}</td>
      <td className="px-4 py-3">
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{swap.accessTier || "—"}</span>
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={onProvision}
          disabled={busy}
          className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Provision new Cloud PC"}
        </button>
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
      title="Save as swap"
      subtitle={`Export ${cpc.displayName} to blob storage as a persistent VHD.`}
      onClose={onCancel}
      disabled={busy}
    >
      <label className="block text-sm font-medium text-gray-700 mb-1">Swap label</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. project-alpha-sprint-3"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
        autoFocus
        disabled={busy}
      />
      <p className="text-xs text-gray-400 mt-1">
        A label for your records. Windows 365 names the blob itself.
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
          {busy ? "Submitting…" : "Save swap"}
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
  const name = friendlyName(swap.name, cloudPCs);
  return (
    <DialogShell
      title="Provision new Cloud PC from swap"
      subtitle={`Creates a new Cloud PC from "${name}" without touching existing ones.`}
      onClose={onCancel}
      disabled={busy}
    >
      <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800">
        A <strong>new</strong> Cloud PC will be provisioned and assigned to you. Your existing Cloud PCs are
        unaffected. Provisioning typically takes 15–45 min.
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

function ReplaceDialog({
  cpc,
  swaps,
  cloudPCs,
  busy,
  onCancel,
  onConfirm,
}: {
  cpc: any;
  swaps: any[];
  cloudPCs: any[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (swap: any) => void;
}) {
  const sorted = useMemo(
    () => [...swaps].sort((a, b) => new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime()),
    [swaps],
  );
  const [selected, setSelected] = useState<any | null>(sorted[0] ?? null);

  return (
    <DialogShell
      title={`Replace ${cpc.displayName} from swap`}
      onClose={onCancel}
      disabled={busy}
    >
      <p className="text-sm text-gray-600 mb-3">
        Windows 365 can&apos;t swap disks on an existing Cloud PC, so this workflow:
      </p>
      <ol className="list-decimal list-inside text-xs text-gray-600 space-y-1 mb-4">
        <li>Provisions a <strong>new</strong> Cloud PC from the selected swap (15–45 min).</li>
        <li>Once it&apos;s ready, you confirm removal of the old one.</li>
      </ol>

      <label className="block text-sm font-medium text-gray-700 mb-1">Choose swap</label>
      <div className="max-h-64 overflow-auto border border-gray-200 rounded-md divide-y">
        {sorted.length === 0 && (
          <div className="p-3 text-sm text-gray-500">No saved swaps available.</div>
        )}
        {sorted.map((s) => (
          <label
            key={s.name}
            className={`flex items-start gap-2 p-3 text-sm cursor-pointer hover:bg-gray-50 ${
              selected?.name === s.name ? "bg-blue-50" : ""
            }`}
          >
            <input
              type="radio"
              name="swap"
              checked={selected?.name === s.name}
              onChange={() => setSelected(s)}
              className="mt-0.5"
              disabled={busy}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 truncate">{friendlyName(s.name, cloudPCs)}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {formatSize(s.size)} · {formatDate(s.createdOn)} · {s.accessTier || "—"}
              </div>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-4 bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800">
        <strong>Heads up:</strong> until you confirm removal, you&apos;ll temporarily have two Cloud PCs — the
        existing one and the new replacement. Both count against your licence/quota.
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
          onClick={() => selected && onConfirm(selected)}
          disabled={!selected || busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Start replacement"}
        </button>
      </div>
    </DialogShell>
  );
}

function DeleteConfirmDialog({
  cpc,
  isReplacement,
  busy,
  onCancel,
  onConfirm,
}: {
  cpc: any;
  isReplacement: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell title={`Remove ${cpc.displayName}?`} onClose={onCancel} disabled={busy}>
      <div className="bg-red-50 border border-red-200 rounded-md p-3 text-xs text-red-800">
        {isReplacement ? (
          <>
            The replacement Cloud PC is ready. Removing <strong>{cpc.displayName}</strong> starts Intune&apos;s
            grace-period workflow — the device will be decommissioned shortly.
          </>
        ) : (
          <>
            Removing <strong>{cpc.displayName}</strong> starts Intune&apos;s grace-period workflow. Any local
            changes not captured in a swap will be lost.
          </>
        )}
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
          className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Removing…" : "Remove Cloud PC"}
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
