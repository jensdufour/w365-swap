"use client";

import { useEffect, useState } from "react";
import { useMsal } from "@azure/msal-react";
import { mosaicApi, StateRecord } from "@/lib/mosaic-api";

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}h ago`;
  return d.toLocaleString();
}

function StatusBadge({ status }: { status: StateRecord["status"] }) {
  const styles: Record<StateRecord["status"], string> = {
    committed: "bg-green-100 text-green-800",
    pending: "bg-amber-100 text-amber-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

export function MosaicDashboard() {
  const { instance } = useMsal();
  const [states, setStates] = useState<StateRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      setError(null);
      const r = await mosaicApi.listStates(instance);
      setStates(r.states);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    setCreating(true);
    try {
      const label = `manual-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
      await mosaicApi.createState(instance, { label });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Saved states</h2>
          <p className="mt-1 text-sm text-gray-500">
            Each state is an encrypted snapshot of your user-data, captured by the
            Mosaic agent. The plaintext key (DEK) is wrapped by your tenant&apos;s
            HSM-backed KEK and never leaves Azure Key Vault.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="text-sm border border-gray-300 bg-white text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            title="Create a placeholder state for testing. The agent normally does this."
          >
            {creating ? "Creating..." : "+ New state (test)"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          Loading...
        </div>
      ) : !states || states.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
          <p className="text-gray-700 font-medium">No states yet</p>
          <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
            Once the Mosaic agent is installed on your Cloud PC, your captured
            states will appear here. You can also create a placeholder above to
            test the API.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Label
                </th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Status
                </th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Captured
                </th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Size
                </th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Chunks
                </th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {states.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    <div className="font-medium text-gray-900">{s.label ?? "(unlabeled)"}</div>
                    <div className="text-xs text-gray-400 font-mono">{s.id.slice(0, 8)}…</div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700" title={s.createdAt}>
                    {formatDate(s.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{formatBytes(s.totalSize)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{s.chunkCount ?? "—"}</td>
                  <td className="px-4 py-3 text-sm text-right">
                    <button
                      disabled
                      title="Restore is performed by the Mosaic agent — not yet shipped."
                      className="text-xs text-gray-400 cursor-not-allowed border border-gray-200 px-3 py-1 rounded"
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs text-gray-400">
        Mosaic v0 — the API and vault are live; the agent and full restore flow
        are in active development.
      </p>
    </main>
  );
}
