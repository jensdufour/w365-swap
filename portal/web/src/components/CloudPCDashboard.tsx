"use client";

import { useMsal } from "@azure/msal-react";
import { useCallback, useEffect, useState } from "react";
import { cloudPcApi } from "@/lib/api-client";

const STORAGE_ACCOUNT_ID = process.env.NEXT_PUBLIC_STORAGE_ACCOUNT_ID || "";

export function CloudPCDashboard() {
  const { instance } = useMsal();
  const [cloudPCs, setCloudPCs] = useState<any[]>([]);
  const [swaps, setSwaps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [swapsLoading, setSwapsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [loadingSwap, setLoadingSwap] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState<any | null>(null);
  const [showLoadDialog, setShowLoadDialog] = useState<any | null>(null);

  const loadCloudPCs = useCallback(async () => {
    try {
      setLoading(true);
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
      setSwapsLoading(true);
      const data = await cloudPcApi.listSwaps(instance);
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
  }, [loadCloudPCs, loadSwaps]);

  // Track operations that have been submitted (show progress in-dialog)
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadResult, setLoadResult] = useState<"success" | "error" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Auto-poll swaps list when an export is in progress
  const [pendingExports, setPendingExports] = useState<number>(0);

  useEffect(() => {
    if (pendingExports === 0) return;
    const interval = setInterval(() => loadSwaps(), 30_000);
    return () => clearInterval(interval);
  }, [pendingExports, loadSwaps]);

  const handleSaveSwap = async (cloudPcId: string, projectName: string) => {
    setSaving(cloudPcId);
    setSaveResult(null);
    setSaveError(null);
    try {
      await cloudPcApi.saveSwap(instance, {
        cloudPcId,
        projectName,
        storageAccountId: STORAGE_ACCOUNT_ID,
        accessTier: "cool",
      });
      setSaveResult("success");
      setPendingExports((n) => n + 1);
    } catch (err: any) {
      setSaveError(err.message);
      setSaveResult("error");
    } finally {
      setSaving(null);
    }
  };

  const handleLoadSwap = async (blobName: string) => {
    const account = instance.getActiveAccount();
    if (!account?.localAccountId) {
      setLoadError("Cannot determine user ID. Please sign out and back in.");
      setLoadResult("error");
      return;
    }
    setLoadingSwap(blobName);
    setLoadResult(null);
    setLoadError(null);
    try {
      await cloudPcApi.loadSwap(instance, {
        userId: account.localAccountId,
        storageAccountId: STORAGE_ACCOUNT_ID,
        blobName,
      });
      setLoadResult("success");
    } catch (err: any) {
      setLoadError(err.message);
      setLoadResult("error");
    } finally {
      setLoadingSwap(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "\u2014";
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  };

  const formatDate = (iso: string) => {
    if (!iso) return "\u2014";
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  const friendlyName = (blobName: string) =>
    blobName.replace(/^.*\//, "").replace(/\.(vhdx?|vmgs)$/i, "");

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
    <div className="space-y-8">
      {/* ─── Cloud PCs ─── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Your Cloud PCs</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Select a Cloud PC to save its current state as a swap
            </p>
          </div>
          <button
            onClick={() => {
              loadCloudPCs();
              loadSwaps();
            }}
            className="text-sm bg-white border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {cloudPCs.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500 text-sm">
            No Cloud PCs assigned to your account.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {cloudPCs.map((cpc) => {
              const isRunning = ["provisioned", "running"].includes(cpc.status);
              return (
                <div
                  key={cpc.id}
                  className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 truncate">{cpc.displayName}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                          isRunning ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            isRunning ? "bg-green-500" : "bg-gray-400"
                          }`}
                        />
                        {cpc.status}
                      </span>
                      {cpc.servicePlanName && (
                        <span className="text-xs text-gray-400">{cpc.servicePlanName}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setShowSaveDialog(cpc)}
                    disabled={saving === cpc.id}
                    className="shrink-0 bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {saving === cpc.id ? "Saving..." : "Save Swap"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Saved Swaps ─── */}
      <section>
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-900">Saved Swaps</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Previously exported environments stored in Azure &mdash; load any swap to provision a
            new Cloud PC from it
          </p>
        </div>

        {swapsLoading ? (
          <div className="text-gray-500 text-sm py-4">Loading saved swaps...</div>
        ) : swaps.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <p className="text-gray-500 text-sm">
              No saved swaps yet. Save a Cloud PC environment to get started.
            </p>
          </div>
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
                {swaps.map((swap) => (
                  <tr
                    key={swap.name}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {friendlyName(swap.name)}
                      <div className="text-xs text-gray-400 font-normal truncate max-w-xs">
                        {swap.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{formatSize(swap.size)}</td>
                    <td className="px-4 py-3 text-gray-600">{formatDate(swap.createdOn)}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                        {swap.accessTier || "\u2014"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setShowLoadDialog(swap)}
                        disabled={loadingSwap === swap.name}
                        className="bg-green-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                      >
                        {loadingSwap === swap.name ? "Loading..." : "Load Swap"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Save Swap dialog ─── */}
      {showSaveDialog && (
        <SaveSwapDialog
          cloudPC={showSaveDialog}
          saving={saving === showSaveDialog.id}
          result={saveResult}
          errorMessage={saveError}
          onSave={(name) => handleSaveSwap(showSaveDialog.id, name)}
          onClose={() => {
            setShowSaveDialog(null);
            setSaveResult(null);
            setSaveError(null);
          }}
        />
      )}

      {/* ─── Load Swap dialog ─── */}
      {showLoadDialog && (
        <LoadSwapDialog
          swap={showLoadDialog}
          loading={loadingSwap === showLoadDialog.name}
          result={loadResult}
          errorMessage={loadError}
          onLoad={() => handleLoadSwap(showLoadDialog.name)}
          onClose={() => {
            setShowLoadDialog(null);
            setLoadResult(null);
            setLoadError(null);
          }}
        />
      )}
    </div>
  );
}

/* ─── Indeterminate Progress Bar ─── */
function ProgressBar({ label }: { label: string }) {
  return (
    <div className="my-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-gray-700">{label}</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
        <div
          className="bg-blue-600 h-2 rounded-full animate-progress"
          style={{ width: "30%" }}
        />
      </div>
      <style jsx>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(250%); }
          100% { transform: translateX(-100%); }
        }
        .animate-progress {
          animation: progress 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

/* ─── Save Swap Dialog ─── */
function SaveSwapDialog({
  cloudPC,
  saving,
  result,
  errorMessage,
  onSave,
  onClose,
}: {
  cloudPC: any;
  saving: boolean;
  result: "success" | "error" | null;
  errorMessage: string | null;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-30" onClick={!saving ? onClose : undefined} />
      <div className="fixed inset-0 flex items-center justify-center z-40 px-4">
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Save Swap</h3>

          {result === "success" ? (
            <>
              <div className="flex items-center gap-3 my-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                <svg className="w-6 h-6 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-green-800">Export initiated</p>
                  <p className="text-xs text-green-700 mt-0.5">
                    Your Cloud PC environment is being exported to storage. This typically takes 20-60 minutes.
                    The swap will appear in the Saved Swaps list once complete.
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Done
                </button>
              </div>
            </>
          ) : result === "error" ? (
            <>
              <div className="flex items-center gap-3 my-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <svg className="w-6 h-6 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-red-800">Failed to save swap</p>
                  <p className="text-xs text-red-700 mt-0.5">{errorMessage}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </>
          ) : saving ? (
            <>
              <p className="text-sm text-gray-500">
                Submitting export request for <strong>{cloudPC.displayName}</strong>...
              </p>
              <ProgressBar label="Initiating export..." />
              <p className="text-xs text-gray-400">Please wait while the request is submitted to Azure.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">
                Export <strong>{cloudPC.displayName}</strong> to blob storage as a persistent VHD. This
                preserves the entire environment even after Cloud PC lifecycle events.
              </p>

              <label className="block text-sm font-medium text-gray-700 mb-1">Swap name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. project-alpha-sprint-3"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                autoFocus
              />
              <p className="text-xs text-gray-400 mt-1">
                This becomes the blob filename. Typically takes 20-60 min to complete.
              </p>

              <div className="flex justify-end gap-2 mt-6">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => onSave(name)}
                  disabled={!name.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  Save Swap
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ─── Load Swap Dialog ─── */
function LoadSwapDialog({
  swap,
  loading,
  result,
  errorMessage,
  onLoad,
  onClose,
}: {
  swap: any;
  loading: boolean;
  result: "success" | "error" | null;
  errorMessage: string | null;
  onLoad: () => void;
  onClose: () => void;
}) {
  const friendlyName = swap.name.replace(/^.*\//, "").replace(/\.(vhdx?|vmgs)$/i, "");

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-30" onClick={!loading ? onClose : undefined} />
      <div className="fixed inset-0 flex items-center justify-center z-40 px-4">
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Load Swap</h3>

          {result === "success" ? (
            <>
              <div className="flex items-center gap-3 my-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                <svg className="w-6 h-6 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-green-800">Provisioning started</p>
                  <p className="text-xs text-green-700 mt-0.5">
                    A new Cloud PC is being provisioned from <strong>{friendlyName}</strong>.
                    This typically takes 15-45 minutes. It will appear in Your Cloud PCs once ready.
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  Done
                </button>
              </div>
            </>
          ) : result === "error" ? (
            <>
              <div className="flex items-center gap-3 my-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <svg className="w-6 h-6 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-red-800">Failed to load swap</p>
                  <p className="text-xs text-red-700 mt-0.5">{errorMessage}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </>
          ) : loading ? (
            <>
              <p className="text-sm text-gray-500">
                Submitting import request for <strong>{friendlyName}</strong>...
              </p>
              <ProgressBar label="Initiating provisioning..." />
              <p className="text-xs text-gray-400">Please wait while the request is submitted to Azure.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">
                Provision a new Cloud PC from <strong>{friendlyName}</strong>. This will create a
                fresh Cloud PC with the exact state from when the swap was saved.
              </p>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 mb-4">
                <strong>Note:</strong> This creates a <em>new</em> Cloud PC &mdash; it does not replace
                your existing one. The new Cloud PC will appear in your list once provisioning completes
                (15-45 minutes). Your existing Cloud PCs are not affected.
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={onLoad}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  Load Swap
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
