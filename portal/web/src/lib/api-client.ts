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

  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  if (!response.ok) {
    throw new Error(json.error || `API request failed: ${response.status}`);
  }

  return json.data as T;
}

/** Cloud PC & Swap API client */
export const cloudPcApi = {
  list: (msal: IPublicClientApplication) =>
    apiRequest<any[]>(msal, `/cloudpcs`),

  /** List W365-retained in-service snapshots for a Cloud PC (used by Restore). */
  listSnapshots: (msal: IPublicClientApplication, cloudPcId: string) =>
    apiRequest<any[]>(msal, `/cloudpcs/${cloudPcId}/snapshots`),

  /** Restore a Cloud PC in place to one of its own in-service snapshots. */
  restoreCloudPc: (msal: IPublicClientApplication, cloudPcId: string, snapshotId: string) =>
    apiRequest<any>(msal, `/cloudpcs/${cloudPcId}/restore`, {
      method: "POST",
      body: JSON.stringify({ snapshotId }),
    }),

  /** Save a swap: export Cloud PC VHD to blob storage */
  saveSwap: (msal: IPublicClientApplication, data: { cloudPcId: string; projectName: string; storageAccountId: string; accessTier?: string }) =>
    apiRequest<any>(msal, `/environments/export`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  /** List saved swaps (VHD blobs in storage) */
  listSwaps: (msal: IPublicClientApplication) =>
    apiRequest<any[]>(msal, `/swaps`),

  /**
   * Provision a new Cloud PC from a saved swap.
   * Graph's importSnapshot always creates a NEW Cloud PC — it cannot replace
   * an existing one in place.
   */
  provisionFromSwap: (msal: IPublicClientApplication, data: { userId: string; storageAccountId: string; blobName: string; containerName?: string }) =>
    apiRequest<any>(msal, `/environments/import`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};
