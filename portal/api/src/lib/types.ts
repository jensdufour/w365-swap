/**
 * Mosaic API — shared domain types.
 *
 * These mirror the v0 manifest schema. Wire format is JSON over Cosmos SQL API
 * for metadata and Azure Blob Storage for chunk payloads.
 */

export interface AuthContext {
  /** Entra ID object id (oid claim). Stable per user per tenant. */
  userId: string;
  /** Entra ID tenant id (tid claim). */
  tenantId: string;
  /** User principal name, when present. Useful for logs only — not auth. */
  upn?: string;
}

export type StateStatus = "pending" | "committed" | "failed";

/**
 * One saved user-state. Created when the agent begins capture, transitioned
 * to `committed` after all chunks upload + manifest is written.
 *
 * Cosmos partition key: /userId. Service never sees plaintext content.
 */
export interface StateRecord {
  /** Stable id, generated server-side. */
  id: string;
  /** Cosmos partition key. */
  userId: string;
  /** Manifest schema version the agent used to capture this state. */
  manifestVersion: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  status: StateStatus;
  /** Optional human-readable label. */
  label?: string;
  /** Cloud PC id when applicable. */
  cloudPcId?: string;
  /** Total plaintext bytes across all chunks (informational, may be stale). */
  totalSize?: number;
  chunkCount?: number;
  /**
   * Per-state Data Encryption Key (DEK) wrapped by the customer's KEK in
   * Azure Key Vault using RSA-OAEP-256. Base64url-encoded ciphertext.
   * Service never persists or transmits the plaintext DEK. Only an
   * authenticated owner can call /states/{id}/dek to unwrap it.
   */
  wrappedDek?: string;
  /** Full Key Vault key id (vault URL + name + version) used to wrap the DEK. */
  kekKid?: string;
  /** Symmetric algorithm the agent uses with the DEK. */
  dekAlgorithm?: "AES-256-GCM";
}

/**
 * Chunk metadata (one per FastCDC chunk). The actual ciphertext lives in
 * blob storage at `chunks/{userId}/{hash}`. PK /userId — chunks are deduped
 * per-user since per-state DEKs are unique.
 */
export interface ChunkRecord {
  /** Cosmos document id; equals `hash`. */
  id: string;
  hash: string;
  userId: string;
  size: number;
  /** Reference count across active StateRecords. GC-able when 0. */
  refs: number;
  createdAt: string;
}

export interface ChunkSAS {
  url: string;
  expiresOn: string;
  blobName: string;
}
