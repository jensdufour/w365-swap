import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";
import { isValidGuid, isValidAzureResourceId, isValidAccessTier, isValidBlobName, sanitizeErrorMessage } from "../lib/validation.js";

/**
 * POST /api/environments/export
 * Exports a Cloud PC environment as a VHD snapshot to Azure Storage.
 * 
 * Body:
 *   - cloudPcId: Cloud PC to export
 *   - projectName: label for the archived environment
 *   - storageAccountId: Azure resource ID for storage
 *   - accessTier: hot | cool | cold | archive (default: cool)
 */
async function exportEnvironment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const { cloudPcId, projectName, storageAccountId, accessTier } = body as {
    cloudPcId?: string;
    projectName?: string;
    storageAccountId?: string;
    accessTier?: string;
  };

  if (!cloudPcId || !projectName || !storageAccountId) {
    return { status: 400, jsonBody: { error: "cloudPcId, projectName, and storageAccountId are required" } };
  }

  if (!isValidGuid(cloudPcId)) {
    return { status: 400, jsonBody: { error: "Invalid cloudPcId format" } };
  }
  if (!isValidAzureResourceId(storageAccountId)) {
    return { status: 400, jsonBody: { error: "Invalid storageAccountId format" } };
  }
  if (accessTier && !isValidAccessTier(accessTier)) {
    return { status: 400, jsonBody: { error: "Invalid accessTier" } };
  }

  try {
    const client = createOboGraphClient(token);

    // Create snapshot to customer storage
    await client
      .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}/createSnapshot`)
      .version("beta")
      .post({
        storageAccountId,
        accessTier: accessTier || "cool",
      });

    return {
      status: 202,
      jsonBody: {
        data: {
          cloudPcId,
          projectName,
          status: "inProgress",
          message: "Export initiated. The VHD will be stored in your Azure Storage account. This may take 20-60 minutes.",
        },
      },
    };
  } catch (error: any) {
    context.error("Failed to export environment:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

/**
 * POST /api/environments/import
 * Imports a VHD from Azure Storage to provision a new Cloud PC.
 * 
 * Body:
 *   - userId: Entra ID user ID to assign the CPC to
 *   - storageAccountId: Azure resource ID of storage with VHD
 *   - containerName: blob container (default: snapshots)
 *   - blobName: VHD blob path
 *   - guestStateBlobName: optional guest state blob
 *   - projectName: project label
 */
async function importEnvironment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const { userId, storageAccountId, containerName, blobName, guestStateBlobName } = body as {
    userId?: string;
    storageAccountId?: string;
    containerName?: string;
    blobName?: string;
    guestStateBlobName?: string;
  };

  if (!userId || !storageAccountId || !blobName) {
    return { status: 400, jsonBody: { error: "userId, storageAccountId, and blobName are required" } };
  }

  if (!isValidGuid(userId)) {
    return { status: 400, jsonBody: { error: "Invalid userId format" } };
  }
  if (!isValidAzureResourceId(storageAccountId)) {
    return { status: 400, jsonBody: { error: "Invalid storageAccountId format" } };
  }
  if (!isValidBlobName(blobName)) {
    return { status: 400, jsonBody: { error: "Invalid blobName format" } };
  }

  try {
    const client = createOboGraphClient(token);

    const sourceFiles: Record<string, unknown>[] = [
      {
        sourceType: "azureStorageAccount",
        fileType: "dataFile",
        storageBlobInfo: {
          storageAccountId,
          containerName: containerName || "snapshots",
          blobName,
        },
      },
    ];

    if (guestStateBlobName) {
      sourceFiles.push({
        sourceType: "azureStorageAccount",
        fileType: "virtualMachineGuestState",
        storageBlobInfo: {
          storageAccountId,
          containerName: containerName || "snapshots",
          blobName: guestStateBlobName,
        },
      });
    }

    const result = await client
      .api("/deviceManagement/virtualEndpoint/snapshots/importSnapshot")
      .version("beta")
      .post({
        sourceFiles,
        assignedUserId: userId,
      });

    return {
      status: 202,
      jsonBody: {
        data: {
          importStatus: result.importStatus,
          policyName: result.policyName,
          message: "Import initiated. A new Cloud PC will be provisioned (estimated 15-45 minutes).",
        },
      },
    };
  } catch (error: any) {
    context.error("Failed to import environment:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

app.http("exportEnvironment", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "environments/export",
  handler: exportEnvironment,
});

app.http("importEnvironment", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "environments/import",
  handler: importEnvironment,
});
