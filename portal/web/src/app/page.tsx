"use client";

import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { apiScopes } from "@/lib/msal-config";
import { CloudPCDashboard } from "@/components/CloudPCDashboard";

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
            <h1 className="text-3xl font-bold text-gray-900">W365 Swap</h1>
            <p className="mt-2 text-gray-600">
              Manage your Windows 365 development environments
            </p>
          </div>
          <p className="text-sm text-gray-500 mb-6">
            Sign in with your organization account to view and manage your Cloud PC environments.
          </p>
          <button
            onClick={handleLogin}
            className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Sign in with Microsoft
          </button>
          <p className="mt-4 text-xs text-amber-600">
            ⚠ Uses Microsoft Graph Beta APIs — not supported for production use
          </p>
        </div>
      </div>
    );
  }

  const account = instance.getActiveAccount();

  return (
    <div className="min-h-screen">
      {/* Header bar — mirrors Dev Box portal header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">W365 Swap</h1>
          <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium">
            Beta
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

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <CloudPCDashboard />
      </main>
    </div>
  );
}
