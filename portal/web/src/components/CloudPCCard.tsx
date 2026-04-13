"use client";

import { useState } from "react";

interface CloudPCCardProps {
  cloudPC: any;
  isActionInProgress: boolean;
  onSnapshot: () => void;
  onPower: (action: "start" | "stop") => void;
  onViewSnapshots: () => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  provisioned: { bg: "bg-green-50", text: "text-green-700", dot: "bg-green-500" },
  running: { bg: "bg-green-50", text: "text-green-700", dot: "bg-green-500" },
  poweredOff: { bg: "bg-gray-50", text: "text-gray-600", dot: "bg-gray-400" },
  restoring: { bg: "bg-yellow-50", text: "text-yellow-700", dot: "bg-yellow-500" },
  provisioning: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500" },
  failed: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
};

/**
 * Cloud PC tile card — mirrors the Dev Box developer portal card design.
 * Shows: name, status indicator, image, SKU, project assignment.
 * Actions menu: Connect, Snapshot, Power, View Snapshots.
 */
export function CloudPCCard({
  cloudPC,
  isActionInProgress,
  onSnapshot,
  onPower,
  onViewSnapshots,
}: CloudPCCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const status = cloudPC.status || "unknown";
  const style = STATUS_STYLES[status] || STATUS_STYLES.poweredOff;
  const isRunning = ["provisioned", "running"].includes(status);
  const projectName = cloudPC.projectName || "Unassigned";

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      {/* Card header with status */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">
              {cloudPC.displayName}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                {status}
              </span>
              {cloudPC.powerState && cloudPC.powerState !== "unknown" && (
                <span className="text-xs text-gray-500">{cloudPC.powerState}</span>
              )}
            </div>
          </div>

          {/* Actions menu (three-dot) — matches Dev Box portal pattern */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
              disabled={isActionInProgress}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1">
                  {isRunning ? (
                    <MenuButton onClick={() => { onPower("stop"); setMenuOpen(false); }}>
                      Shut down
                    </MenuButton>
                  ) : (
                    <MenuButton onClick={() => { onPower("start"); setMenuOpen(false); }}>
                      Start
                    </MenuButton>
                  )}
                  <MenuButton onClick={() => { onSnapshot(); setMenuOpen(false); }}>
                    Take snapshot
                  </MenuButton>
                  <MenuButton onClick={() => { onViewSnapshots(); setMenuOpen(false); }}>
                    Snapshots &amp; Restore
                  </MenuButton>
                  <hr className="my-1 border-gray-100" />
                  <MenuButton
                    onClick={() => {
                      window.open("https://windows365.microsoft.com", "_blank");
                      setMenuOpen(false);
                    }}
                  >
                    Open in Windows 365 ↗
                  </MenuButton>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Card body — environment details */}
      <div className="px-4 pb-4 space-y-2">
        <DetailRow label="Project" value={projectName} />
        <DetailRow label="Image" value={cloudPC.imageDisplayName || "—"} />
        <DetailRow label="SKU" value={cloudPC.servicePlanName || "—"} />
        <DetailRow label="User" value={cloudPC.userPrincipalName || "—"} />
        {cloudPC.deviceRegionName && (
          <DetailRow label="Region" value={cloudPC.deviceRegionName} />
        )}
      </div>

      {/* Card footer — primary action (mirrors Dev Box "Connect" button) */}
      <div className="px-4 pb-4">
        {isRunning ? (
          <a
            href="https://windows365.microsoft.com"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            Connect
          </a>
        ) : (
          <button
            onClick={() => onPower("start")}
            disabled={isActionInProgress}
            className="w-full bg-gray-100 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {isActionInProgress ? "Starting..." : "Start"}
          </button>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 truncate ml-2 max-w-[60%] text-right">{value}</span>
    </div>
  );
}

function MenuButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
    >
      {children}
    </button>
  );
}
