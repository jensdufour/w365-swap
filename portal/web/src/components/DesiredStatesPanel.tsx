"use client";

import { useMsal } from "@azure/msal-react";
import { useCallback, useEffect, useState } from "react";
import { desiredStatesApi, DesiredState } from "@/lib/api-client";

/**
 * DesiredStatesPanel — MOCK / VISION UI.
 *
 * Demonstrates a hypothetical "one compute, many attachable OS disks" model
 * on top of Windows 365. Nothing here touches a real Cloud PC; state is
 * round-tripped through a dedicated /api/desired-states endpoint backed by a
 * per-user JSON index blob.
 */
export function DesiredStatesPanel() {
  const { instance } = useMsal();

  const [states, setStates] = useState<DesiredState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [simulatingAttachId, setSimulatingAttachId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newSize, setNewSize] = useState(256);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await desiredStatesApi.list(instance);
      setStates(data ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [instance]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await desiredStatesApi.create(instance, {
        name: newName.trim(),
        description: newDesc.trim(),
        sizeGB: newSize,
      });
      setNewName("");
      setNewDesc("");
      setNewSize(256);
      setShowCreate(false);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleAttach(state: DesiredState) {
    setBusyId(state.id);
    setSimulatingAttachId(state.id);
    // Simulated propagation delay so the UI demos the "applying desired state"
    // moment rather than an instant flip.
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await desiredStatesApi.attach(instance, state.id);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
      setSimulatingAttachId(null);
    }
  }

  async function handleDetach(state: DesiredState) {
    setBusyId(state.id);
    try {
      await desiredStatesApi.detach(instance, state.id);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(state: DesiredState) {
    if (!window.confirm(`Delete desired state "${state.name}"? This cannot be undone.`)) return;
    setBusyId(state.id);
    try {
      await desiredStatesApi.remove(instance, state.id);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const attached = states.find((s) => s.status === "attached");

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            Desired States
            <span className="inline-flex items-center rounded-full bg-purple-100 text-purple-700 text-[10px] font-medium uppercase tracking-wide px-2 py-0.5">
              Preview · Simulated
            </span>
            <span
              className="relative inline-flex items-center group"
              tabIndex={0}
              aria-label="What Microsoft would need to ship"
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] text-gray-500 cursor-help select-none">
                i
              </span>
              <span
                role="tooltip"
                className="pointer-events-none invisible group-hover:visible group-focus-within:visible absolute left-5 top-1/2 -translate-y-1/2 z-20 w-80 rounded-md border border-gray-200 bg-white p-3 text-[11px] leading-relaxed text-gray-700 shadow-lg"
              >
                <span className="block font-semibold text-gray-900 mb-1">
                  What Microsoft would need to ship
                </span>
                <ul className="list-disc pl-4 space-y-1">
                  <li>
                    Decouple CPC compute from the OS disk (today they&apos;re one immutable unit).
                  </li>
                  <li>
                    Graph action{" "}
                    <code className="font-mono">POST /virtualEndpoint/cloudPCs/&#123;id&#125;/attachDisk</code>{" "}
                    that swaps the boot disk and reboots.
                  </li>
                  <li>
                    A first-class <code className="font-mono">cloudPcDiskImage</code> resource
                    (per-user OS disks, not just gallery images).
                  </li>
                  <li>
                    Licensing change: one Cloud PC license covers N owned disks, billed for storage
                    only when detached.
                  </li>
                  <li>
                    Per-disk identity/join state so attach doesn&apos;t require re-enrollment.
                  </li>
                </ul>
                <span className="block mt-2 text-gray-400 italic">None of these exist today.</span>
              </span>
            </span>
          </h2>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Vision of a future Windows 365 capability: pay once for the Cloud PC compute, then attach
            and detach multiple independent OS-disk &quot;desired states&quot; on demand — effectively
            getting several Cloud PCs that share one license. This panel is fully mocked; no real
            Cloud PC is modified.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-3 py-1.5"
        >
          {showCreate ? "Cancel" : "+ New state"}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_120px] gap-3">
            <label className="text-sm">
              <span className="block text-gray-700 mb-1">Name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Project Alpha"
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-gray-700 mb-1">Description</span>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                maxLength={240}
                placeholder="What&apos;s installed / configured"
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-gray-700 mb-1">Size (GB)</span>
              <select
                value={newSize}
                onChange={(e) => setNewSize(Number(e.target.value))}
                className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm bg-white"
              >
                <option value={128}>128</option>
                <option value={256}>256</option>
                <option value={512}>512</option>
                <option value={1024}>1024</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-gray-300 bg-white text-gray-700 text-sm px-3 py-1.5 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="rounded-md bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
            >
              {creating ? "Creating…" : "Create state"}
            </button>
          </div>
        </div>
      )}

      {attached && (
        <div className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          Currently attached: <span className="font-semibold">{attached.name}</span>
          {attached.lastAttachedAt && (
            <span className="text-green-700/80">
              {" "}
              · since {new Date(attached.lastAttachedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading desired states…</div>
      ) : states.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm text-gray-600">
            No desired states yet. Create one to simulate attaching a saved OS disk to your Cloud PC.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {states.map((s) => {
            const isAttached = s.status === "attached";
            const isSimulating = simulatingAttachId === s.id;
            const isBusy = busyId === s.id;
            return (
              <div
                key={s.id}
                className={`rounded-lg border p-4 bg-white transition-shadow ${
                  isAttached ? "border-green-400 shadow-sm" : "border-gray-200 hover:shadow-sm"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900 truncate">{s.name}</h3>
                      {isAttached && (
                        <span className="inline-flex items-center rounded-full bg-green-100 text-green-700 text-[10px] font-medium px-2 py-0.5">
                          Attached
                        </span>
                      )}
                      {isSimulating && (
                        <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 text-[10px] font-medium px-2 py-0.5 animate-pulse">
                          Applying…
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p className="mt-1 text-xs text-gray-600 line-clamp-2">{s.description}</p>
                    )}
                    <dl className="mt-2 text-[11px] text-gray-500 space-y-0.5">
                      <div>
                        <span className="text-gray-400">OS:</span> {s.os}
                      </div>
                      <div>
                        <span className="text-gray-400">Size:</span> {s.sizeGB} GB
                      </div>
                      <div>
                        <span className="text-gray-400">Created:</span>{" "}
                        {new Date(s.createdAt).toLocaleDateString()}
                      </div>
                    </dl>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {isAttached ? (
                    <button
                      disabled={isBusy}
                      onClick={() => handleDetach(s)}
                      className="rounded-md bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-800 text-xs font-medium px-2.5 py-1"
                    >
                      {isBusy ? "Detaching…" : "Detach"}
                    </button>
                  ) : (
                    <button
                      disabled={isBusy}
                      onClick={() => handleAttach(s)}
                      className="rounded-md bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1"
                      title={attached ? `Will detach "${attached.name}" first` : undefined}
                    >
                      {isSimulating ? "Attaching…" : "Attach"}
                    </button>
                  )}
                  <button
                    disabled={isBusy || isAttached}
                    onClick={() => handleDelete(s)}
                    className="rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-700 text-xs px-2.5 py-1"
                    title={isAttached ? "Detach before deleting" : "Delete this desired state"}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[11px] text-gray-400 italic">
        Everything on this panel is simulated. Attach/detach operations write to a per-user JSON
        blob and do not reprovision, reboot, or otherwise affect your real Cloud PCs.
      </p>
    </section>
  );
}
