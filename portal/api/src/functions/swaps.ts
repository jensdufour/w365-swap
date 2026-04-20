import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { extractBearerToken } from "../lib/graph-client.js";

// Containers we scan for exported Cloud PC VHDs. Windows 365 creates its own
// per-tenant share container when exporting via Graph createSnapshot (name
// pattern "windows365-share-ent-<suffix>"), so we include any container whose
// name matches that prefix in addition to the manually-provisioned "snapshots"
// container.
const MANAGED_CONTAINER = "snapshots";
const W365_CONTAINER_PREFIX = "windows365-share-";

function getStorageAccountName(): string {
  const id = process.env.STORAGE_ACCOUNT_ID || "";
  // Extract account name from resource ID: .../storageAccounts/<name>
  const match = id.match(/storageAccounts\/([^/]+)/i);
  return match ? match[1] : "";
}

/**
 * GET /api/swaps
 * Lists saved environment swaps (VHD blobs) across all swap-related containers
 * in the configured storage account.
 */
async function listSwaps(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const accountName = getStorageAccountName();
  if (!accountName) {
    return { status: 500, jsonBody: { error: "Storage account not configured" } };
  }

  try {
    const blobService = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      new ManagedIdentityCredential()
    );

    const swaps: Array<{
      name: string;
      containerName: string;
      size: number;
      createdOn: string;
      accessTier: string | undefined;
      contentType: string | undefined;
    }> = [];

    for await (const container of blobService.listContainers()) {
      if (
        container.name !== MANAGED_CONTAINER &&
        !container.name.startsWith(W365_CONTAINER_PREFIX)
      ) {
        continue;
      }

      const containerClient = blobService.getContainerClient(container.name);
      for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
        if (!/\.vhdx?$/i.test(blob.name)) continue;
        swaps.push({
          name: blob.name,
          containerName: container.name,
          size: blob.properties.contentLength || 0,
          createdOn: blob.properties.createdOn?.toISOString() || "",
          accessTier: blob.properties.accessTier,
          contentType: blob.properties.contentType,
        });
      }
    }

    // Sort newest first
    swaps.sort((a, b) => new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime());

    return { status: 200, jsonBody: { data: swaps } };
  } catch (error: any) {
    context.error("Failed to list swaps:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: "Failed to list saved swaps. The storage account may not be accessible." },
    };
  }
}

app.http("listSwaps", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "swaps",
  handler: listSwaps,
});
