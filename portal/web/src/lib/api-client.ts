import { apiScopes } from "./msal-config";
import { IPublicClientApplication } from "@azure/msal-browser";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

async function getAccessToken(msalInstance: IPublicClientApplication): Promise<string> {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) {
    throw new Error("No authenticated account found. Please sign in.");
  }

  const response = await msalInstance.acquireTokenSilent({
    scopes: apiScopes,
    account: accounts[0],
  });

  return response.accessToken;
}

async function apiRequest<T>(
  msalInstance: IPublicClientApplication,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken(msalInstance);

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(json.error || `API request failed: ${response.status}`);
  }

  return json.data as T;
}

/** Cloud PC API client */
export const cloudPcApi = {
  list: (msal: IPublicClientApplication, includeSnapshots = false) =>
    apiRequest<any[]>(msal, `/cloudpcs${includeSnapshots ? "?includeSnapshots=true" : ""}`),

  getSnapshots: (msal: IPublicClientApplication, cloudPcId: string) =>
    apiRequest<any[]>(msal, `/cloudpcs/${cloudPcId}/snapshots`),

  createSnapshot: (msal: IPublicClientApplication, cloudPcId: string, options?: { storageAccountId?: string; accessTier?: string }) =>
    apiRequest<any>(msal, `/cloudpcs/${cloudPcId}/snapshots`, {
      method: "POST",
      body: JSON.stringify(options || {}),
    }),

  restore: (msal: IPublicClientApplication, cloudPcId: string, snapshotId: string) =>
    apiRequest<any>(msal, `/cloudpcs/${cloudPcId}/restore`, {
      method: "POST",
      body: JSON.stringify({ snapshotId }),
    }),

  power: (msal: IPublicClientApplication, cloudPcId: string, action: "start" | "stop") =>
    apiRequest<any>(msal, `/cloudpcs/${cloudPcId}/power`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  exportEnv: (msal: IPublicClientApplication, data: { cloudPcId: string; projectName: string; storageAccountId: string; accessTier?: string }) =>
    apiRequest<any>(msal, `/environments/export`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  importEnv: (msal: IPublicClientApplication, data: { userId: string; storageAccountId: string; blobName: string; containerName?: string; guestStateBlobName?: string }) =>
    apiRequest<any>(msal, `/environments/import`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};
