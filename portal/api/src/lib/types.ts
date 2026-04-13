/** Cloud PC as returned by the Graph Beta API, enriched with portal data. */
export interface CloudPCEnvironment {
  id: string;
  displayName: string;
  status: string;
  userPrincipalName: string;
  imageDisplayName: string;
  servicePlanName: string;
  provisioningType: string;
  powerState?: string;
  productType?: string;
  lastModifiedDateTime: string;
  /** W365 Swap project assignment (from portal state) */
  projectName?: string;
  /** W365 Swap status tracking */
  swapStatus?: "active" | "archived" | "importing" | "exporting" | "untracked";
}

export interface CloudPCSnapshot {
  id: string;
  cloudPcId: string;
  status: string;
  createdDateTime: string;
  lastRestoredDateTime: string | null;
  snapshotType: "automatic" | "manual" | "retention";
  expirationDateTime: string | null;
  healthCheckStatus?: string;
}

export interface SwapOperation {
  operationId: string;
  type: "snapshot" | "export" | "import" | "restore";
  cloudPcId: string;
  projectName?: string;
  status: "inProgress" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

export interface PortalState {
  version: string;
  lastModified: string;
  environments: EnvironmentRecord[];
  operations: SwapOperation[];
}

export interface EnvironmentRecord {
  cloudPcId: string;
  projectName: string;
  status: "active" | "archived" | "importing" | "exporting";
  userPrincipalName: string;
  blobPath: string | null;
  snapshotId: string | null;
  createdAt: string;
  lastModified: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}
