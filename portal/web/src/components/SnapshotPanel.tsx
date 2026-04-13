"use client";

import { useMsal } from "@azure/msal-react";
import { useEffect, useState } from "react";
import { cloudPcApi } from "@/lib/api-client";

interface SnapshotPanelProps {
  cloudPC: any;
  onClose: () => void;
}

/**
 * Side panel for viewing/managing snapshots — mirrors the Dev Box
 * "More Info" and "Snapshot & Restore" slide-over pattern.
 */
export function SnapshotPanel({ cloudPC, onClose }: SnapshotPanelProps) {
  const { instance } = useMsal();
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    loadSnapshots();
  }, [cloudPC.id]);

  const loadSnapshots = async () => {
    try {
      setLoading(true);
      const data = await cloudPcApi.getSnapshots(instance, cloudPC.id);
      setSnapshots(data.sort((a: any, b: any) =>
        new Date(b.createdDateTime).getTime() - new Date(a.createdDateTime).getTime()
      ));
    } catch (err: any) {
      console.error("Failed to load snapshots:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (snapshotId: string) => {
    if (!confirm(
      "Are you sure you want to restore to this snapshot?\n\n" +
      "All changes since this snapshot will be lost. " +
      "The user will be disconnected during the restore process (5-15 minutes)."
    )) {
      return;
    }

    setRestoring(snapshotId);
    try {
      await cloudPcApi.restore(instance, cloudPC.id, snapshotId);
      alert("Restore initiated. The Cloud PC will be unavailable for 5-15 minutes.");
    } catch (err: any) {
      alert(`Failed to restore: ${err.message}`);
    } finally {
      setRestoring(null);
    }
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-30" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-40 overflow-y-auto">
        {/* Panel header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Snapshots &amp; Restore
            </h2>
            <p className="text-sm text-gray-500">{cloudPC.displayName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Cloud PC details */}
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-medium text-gray-900 mb-2">Cloud PC Details</h3>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Status</dt>
              <dd className="text-gray-900">{cloudPC.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Image</dt>
              <dd className="text-gray-900 truncate ml-4">{cloudPC.imageDisplayName || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">SKU</dt>
              <dd className="text-gray-900">{cloudPC.servicePlanName || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">ID</dt>
              <dd className="text-gray-500 text-xs font-mono truncate ml-4">{cloudPC.id}</dd>
            </div>
          </dl>
        </div>

        {/* Warning about restore */}
        <div className="px-6 py-3 bg-amber-50 border-b border-amber-100">
          <p className="text-xs text-amber-800">
            <strong>Note:</strong> Restoring replaces the entire Cloud PC disk with 
            the snapshot state. All changes after the snapshot will be lost. 
            Only snapshots from this same Cloud PC can be used.
          </p>
        </div>

        {/* Snapshot list */}
        <div className="px-6 py-4">
          <h3 className="text-sm font-medium text-gray-900 mb-3">
            Available Snapshots
          </h3>

          {loading ? (
            <div className="text-gray-500 text-sm py-4">Loading snapshots...</div>
          ) : snapshots.length === 0 ? (
            <div className="text-gray-500 text-sm py-4">
              No snapshots available for this Cloud PC.
            </div>
          ) : (
            <div className="space-y-3">
              {snapshots.map((snap) => (
                <div
                  key={snap.id}
                  className="border border-gray-200 rounded-lg p-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {formatDate(snap.createdDateTime)}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          snap.snapshotType === "manual"
                            ? "bg-blue-50 text-blue-700"
                            : snap.snapshotType === "retention"
                            ? "bg-purple-50 text-purple-700"
                            : "bg-gray-50 text-gray-600"
                        }`}>
                          {snap.snapshotType}
                        </span>
                        <span className={`text-xs ${
                          snap.healthCheckStatus === "healthy"
                            ? "text-green-600"
                            : snap.healthCheckStatus === "unhealthy"
                            ? "text-red-600"
                            : "text-gray-500"
                        }`}>
                          {snap.healthCheckStatus || "unknown"}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleRestore(snap.id)}
                      disabled={restoring === snap.id || snap.status !== "ready"}
                      className="text-xs bg-white border border-gray-300 px-3 py-1.5 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {restoring === snap.id ? "Restoring..." : "Restore"}
                    </button>
                  </div>

                  {snap.expirationDateTime && (
                    <div className="text-xs text-gray-400 mt-1">
                      Expires: {formatDate(snap.expirationDateTime)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
