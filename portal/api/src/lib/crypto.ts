import { KeyClient, CryptographyClient, KeyVaultKey } from "@azure/keyvault-keys";
import { DefaultAzureCredential } from "@azure/identity";
import { randomBytes } from "node:crypto";

/**
 * Envelope-encryption helpers for Mosaic's state vault.
 *
 * The Key Encryption Key (KEK) is an HSM-protected RSA-4096 key in Azure
 * Key Vault. The Function App's managed identity has Key Vault Crypto User
 * RBAC, which grants `wrapKey` / `unwrapKey` operations only — never key
 * creation, listing, deletion, or export. The KEK material never leaves
 * the HSM boundary.
 *
 * Per-state Data Encryption Keys (DEKs) are 32 random bytes (AES-256). Each
 * state gets a fresh DEK; we wrap it with the KEK and store only the wrapped
 * form on the Cosmos StateRecord. The agent receives the unwrapped DEK on
 * commit (encrypt path) or restore (decrypt path), uses it client-side for
 * AES-256-GCM on each chunk, and discards it after the operation.
 *
 * The `kekKid` returned with a wrapped DEK is the full versioned key id
 * (e.g. https://vault.vault.azure.net/keys/mosaic-kek/{version}). We persist
 * this so future unwrap calls bind to the exact version that wrapped the
 * DEK, supporting key rotation without breaking previously-saved states.
 */

const VAULT_URL = process.env.KEK_VAULT_URL;
const KEK_NAME = process.env.KEK_KEY_NAME;
const WRAP_ALG = "RSA-OAEP-256" as const;

let keyClient: KeyClient | null = null;
let kekVersionedKey: KeyVaultKey | null = null;
let cachedCryptoClient: CryptographyClient | null = null;
let cachedCryptoClientKid: string | null = null;
let kekFetchedAt = 0;
const KEK_CACHE_MS = 60 * 60 * 1000; // re-fetch the latest KEK every hour

function getKeyClient(): KeyClient {
  if (!VAULT_URL) throw new Error("KEK_VAULT_URL not configured");
  if (!keyClient) {
    keyClient = new KeyClient(VAULT_URL, new DefaultAzureCredential());
  }
  return keyClient;
}

/**
 * Fetch (and cache) the latest version of the KEK. Used when wrapping a new
 * DEK so we always wrap with the most recent rotation.
 */
async function getLatestKek(): Promise<KeyVaultKey> {
  if (!KEK_NAME) throw new Error("KEK_KEY_NAME not configured");
  const now = Date.now();
  if (kekVersionedKey && now - kekFetchedAt < KEK_CACHE_MS) {
    return kekVersionedKey;
  }
  kekVersionedKey = await getKeyClient().getKey(KEK_NAME);
  kekFetchedAt = now;
  return kekVersionedKey;
}

/**
 * Get a CryptographyClient bound to a specific versioned key id. We cache
 * one client per kid because each unwrap call needs the same kid that did
 * the original wrap (key rotation safety).
 */
function getCryptoClient(kid: string): CryptographyClient {
  if (cachedCryptoClient && cachedCryptoClientKid === kid) return cachedCryptoClient;
  cachedCryptoClient = new CryptographyClient(kid, new DefaultAzureCredential());
  cachedCryptoClientKid = kid;
  return cachedCryptoClient;
}

/** Generate a fresh 32-byte (AES-256) Data Encryption Key. */
export function generateDek(): Buffer {
  return randomBytes(32);
}

export interface WrappedDek {
  /** Base64url-encoded RSA-OAEP-256 ciphertext of the DEK. */
  wrapped: string;
  /** Versioned KV key id used to wrap. Required to unwrap later. */
  kekKid: string;
}

/**
 * Wrap a DEK with the latest KEK version. Returns the wrapped form + the
 * exact key id used (so future unwraps bind to the same version).
 */
export async function wrapDek(dek: Buffer): Promise<WrappedDek> {
  const kek = await getLatestKek();
  if (!kek.id) throw new Error("KEK has no key id");
  const crypto = getCryptoClient(kek.id);
  const result = await crypto.wrapKey(WRAP_ALG, dek);
  return {
    wrapped: Buffer.from(result.result).toString("base64url"),
    kekKid: kek.id,
  };
}

/**
 * Unwrap a DEK using the exact key version that wrapped it. Throws if the
 * caller's MI lacks `unwrapKey` permission, the kid is malformed, or the
 * key version has been deleted.
 */
export async function unwrapDek(wrapped: string, kekKid: string): Promise<Buffer> {
  if (!wrapped || !kekKid) throw new Error("wrapped + kekKid required");
  const crypto = getCryptoClient(kekKid);
  const ciphertext = Buffer.from(wrapped, "base64url");
  const result = await crypto.unwrapKey(WRAP_ALG, ciphertext);
  return Buffer.from(result.result);
}
