"use client";

import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { apiScopes } from "@/lib/msal-config";
import { MosaicDashboard } from "@/components/MosaicDashboard";

export default function Home() {
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const handleLogin = () => {
    instance.loginRedirect({ scopes: apiScopes });
  };

  const handleLogout = () => {
    instance.logoutRedirect();
  };

  if (inProgress !== InteractionStatus.None) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500 text-lg">Signing in...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900">Mosaic</h1>
            <p className="mt-2 text-gray-600">User-state vault for Windows 365</p>
          </div>
          <p className="text-sm text-gray-500 mb-6">
            Sign in with your organization account to manage your saved states.
          </p>
          <button
            onClick={handleLogin}
            className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Sign in with Microsoft
          </button>
          <p className="mt-4 text-xs text-amber-600">Pre-release — v0 in active development.</p>
        </div>
      </div>
    );
  }

  const account = instance.getActiveAccount();

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Mosaic</h1>
          <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium">
            v0
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{account?.username}</span>
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="bg-gray-50 min-h-[calc(100vh-57px)]">
        <MosaicDashboard />
      </main>
    </div>
  );
}
