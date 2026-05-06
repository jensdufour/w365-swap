import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  UserDelegationKey,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { ChunkSAS } from "./types";

const accountName = process.env.STATES_STORAGE_ACCOUNT_NAME;
const containerName = process.env.STATES_CONTAINER_NAME ?? "chunks";

let blobService: BlobServiceClient | null = null;
let cachedKey: { key: UserDelegationKey; expiresOn: Date } | null = null;

function getBlobService(): BlobServiceClient {
  if (!accountName) {
    throw new Error("STATES_STORAGE_ACCOUNT_NAME not configured");
  }
  if (!blobService) {
    blobService = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
  }
  return blobService;
}

/**
 * Get (or refresh) the user-delegation key. The key is cached and reused for
 * SAS minting; tokens are short-lived but the key can serve many SAS for an
 * hour. Refreshes 5 min before expiry.
 */
async function getUserDelegationKey(): Promise<UserDelegationKey> {
  if (cachedKey && cachedKey.expiresOn.getTime() - Date.now() > 5 * 60_000) {
    return cachedKey.key;
  }
  const startsOn = new Date(Date.now() - 60_000);
  const expiresOn = new Date(Date.now() + 60 * 60_000);
  const key = await getBlobService().getUserDelegationKey(startsOn, expiresOn);
  cachedKey = { key, expiresOn };
  return key;
}

function buildSas(
  blobName: string,
  permissions: string,
  ttlMinutes: number,
  key: UserDelegationKey,
): ChunkSAS {
  if (!accountName) throw new Error("STATES_STORAGE_ACCOUNT_NAME not configured");
  const expiresOn = new Date(Date.now() + ttlMinutes * 60_000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse(permissions),
      startsOn: new Date(Date.now() - 60_000),
      expiresOn,
      protocol: SASProtocol.Https,
    },
    key,
    accountName,
  ).toString();
  return {
    url: `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sas}`,
    expiresOn: expiresOn.toISOString(),
    blobName,
  };
}

/** Mint a short-lived SAS the agent uses to PUT a chunk. */
export async function mintUploadSAS(userId: string, hash: string, ttlMinutes = 30): Promise<ChunkSAS> {
  const key = await getUserDelegationKey();
  return buildSas(`${userId}/${hash}`, "cw", ttlMinutes, key);
}

/** Mint a short-lived SAS the agent uses to GET a chunk during restore. */
export async function mintDownloadSAS(userId: string, hash: string, ttlMinutes = 30): Promise<ChunkSAS> {
  const key = await getUserDelegationKey();
  return buildSas(`${userId}/${hash}`, "r", ttlMinutes, key);
}
