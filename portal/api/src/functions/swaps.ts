import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { extractBearerToken } from "../lib/graph-client.js";

const CONTAINER_NAME = "snapshots";

function getStorageAccountName(): string {
  const id = process.env.STORAGE_ACCOUNT_ID || "";
  // Extract account name from resource ID: .../storageAccounts/<name>
  const match = id.match(/storageAccounts\/([^/]+)/i);
  return match ? match[1] : "";
}

/**
 * GET /api/swaps
 * Lists saved environment swaps (VHD blobs) in the configured storage account.
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

    const containerClient = blobService.getContainerClient(CONTAINER_NAME);

    // Check if container exists
    const exists = await containerClient.exists();
    if (!exists) {
      return { status: 200, jsonBody: { data: [] } };
    }

    const swaps: Array<{
      name: string;
      size: number;
      createdOn: string;
      accessTier: string | undefined;
      contentType: string | undefined;
    }> = [];

    for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
      if (blob.name.endsWith(".vhd") || blob.name.endsWith(".vhdx")) {
        swaps.push({
          name: blob.name,
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
