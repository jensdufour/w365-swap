import { IPublicClientApplication } from "@azure/msal-browser";
import { apiScopes } from "./msal-config";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

/**
 * StateRecord shape mirrors `portal/api/src/lib/types.ts`. The wrappedDek
 * field is intentionally absent — the API strips it from list and metadata
 * responses; only `POST /states/{id}/dek` ever returns the unwrapped DEK,
 * and the portal never asks for it (only the Rust agent does).
 */
export type StateStatus = "pending" | "committed" | "failed";
export interface StateRecord {
  id: string;
  userId: string;
  manifestVersion: string;
  createdAt: string;
  status: StateStatus;
  label?: string;
  cloudPcId?: string;
  totalSize?: number;
  chunkCount?: number;
  kekKid?: string;
  dekAlgorithm?: "AES-256-GCM";
}

async function getAccessToken(msal: IPublicClientApplication): Promise<string> {
  const accounts = msal.getAllAccounts();
  if (accounts.length === 0) throw new Error("Not signed in.");
  const r = await msal.acquireTokenSilent({ scopes: apiScopes, account: accounts[0] });
  return r.accessToken;
}

async function request<T>(
  msal: IPublicClientApplication,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken(msal);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return json as T;
}

export const mosaicApi = {
  listStates: (msal: IPublicClientApplication) =>
    request<{ states: StateRecord[] }>(msal, "/states"),

  getState: (msal: IPublicClientApplication, id: string) =>
    request<StateRecord>(msal, `/states/${encodeURIComponent(id)}`),

  /** Create a pending state. The Rust agent normally does this; exposing it
   * in the UI is purely for v0 demo purposes. */
  createState: (msal: IPublicClientApplication, body: { label?: string; cloudPcId?: string }) =>
    request<StateRecord>(msal, "/states", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Health check, no auth required. Useful for ops dashboards. */
  health: () => fetch(`${API_BASE}/health`).then((r) => r.json()),
};
