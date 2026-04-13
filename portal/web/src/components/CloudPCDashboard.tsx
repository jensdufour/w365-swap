"use client";

import { useMsal } from "@azure/msal-react";
import { useCallback, useEffect, useState } from "react";
import { cloudPcApi } from "@/lib/api-client";
import { CloudPCCard } from "./CloudPCCard";
import { SnapshotPanel } from "./SnapshotPanel";

export function CloudPCDashboard() {
  const { instance } = useMsal();
  const [cloudPCs, setCloudPCs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCPC, setSelectedCPC] = useState<any | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const loadCloudPCs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await cloudPcApi.list(instance, false);
      setCloudPCs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [instance]);

  useEffect(() => {
    loadCloudPCs();
  }, [loadCloudPCs]);

  const handleSnapshot = async (cloudPcId: string) => {
    setActionInProgress(cloudPcId);
    try {
      await cloudPcApi.createSnapshot(instance, cloudPcId);
      alert("Snapshot creation initiated. Check the Snapshots panel for progress.");
    } catch (err: any) {
      alert(`Failed to create snapshot: ${err.message}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handlePower = async (cloudPcId: string, action: "start" | "stop") => {
    setActionInProgress(cloudPcId);
    try {
      await cloudPcApi.power(instance, cloudPcId, action);
      // Reload after a short delay to reflect new state
      setTimeout(loadCloudPCs, 3000);
    } catch (err: any) {
      alert(`Failed to ${action} Cloud PC: ${err.message}`);
    } finally {
      setActionInProgress(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">Loading your Cloud PCs...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h3 className="text-red-800 font-medium">Failed to load Cloud PCs</h3>
        <p className="text-red-600 text-sm mt-1">{error}</p>
        <button
          onClick={loadCloudPCs}
          className="mt-3 text-sm text-red-700 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Section header — matches Dev Box portal "My dev boxes" section */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">My Environments</h2>
          <p className="text-gray-500 mt-1">
            {cloudPCs.length} Cloud PC{cloudPCs.length !== 1 ? "s" : ""} available
          </p>
        </div>
        <button
          onClick={loadCloudPCs}
          className="text-sm bg-white border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Refresh
        </button>
      </div>

      {cloudPCs.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <h3 className="text-lg font-medium text-gray-900">No Cloud PCs found</h3>
          <p className="text-gray-500 mt-2">
            You don&apos;t have any Cloud PCs assigned. Contact your administrator to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cloudPCs.map((cpc) => (
            <CloudPCCard
              key={cpc.id}
              cloudPC={cpc}
              isActionInProgress={actionInProgress === cpc.id}
              onSnapshot={() => handleSnapshot(cpc.id)}
              onPower={(action) => handlePower(cpc.id, action)}
              onViewSnapshots={() => setSelectedCPC(cpc)}
            />
          ))}
        </div>
      )}

      {/* Snapshot side panel — like Dev Box "More Info" pane */}
      {selectedCPC && (
        <SnapshotPanel
          cloudPC={selectedCPC}
          onClose={() => setSelectedCPC(null)}
        />
      )}
    </div>
  );
}
