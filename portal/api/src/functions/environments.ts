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
    context.error(
      "Failed to import environment:",
      "statusCode=", error?.statusCode,
      "code=", error?.code,
      "body=", typeof error?.body === "string" ? error.body : JSON.stringify(error?.body ?? {}),
      error,
    );

    // Specific guidance for the common "invalidStorageInformation" case. This
    // happens when Graph can't provision from the supplied blob(s) - typically
    // because the caller's saved swap is a Gen2 Cloud PC export (the default)
    // whose .vmgs guest-state companion file isn't present alongside the .vhd.
    // Windows 365's createSnapshot writes only the data VHD to customer
    // storage, so self-exported Gen2 swaps can't be round-tripped through
    // importSnapshot. We surface that up-front.
    if (error?.code === "invalidStorageInformation" && !guestStateBlobName) {
      return {
        status: 400,
        jsonBody: {
          error:
            "Graph rejected the VHD as incomplete (invalidStorageInformation). " +
            "This swap does not have a virtualMachineGuestState (.vmgs) file " +
            "alongside the .vhd. Windows 365 requires both to provision a new " +
            "Cloud PC from a Gen2 snapshot, but createSnapshot only exports " +
            "the data VHD. Use 'Restore' on the original Cloud PC instead, or " +
            "upload a complete Gen1 VHD (or Gen2 .vhdx + .vmgs pair) you own.",
        },
      };
    }

    const detail =
      (typeof error?.code === "string" && typeof error?.message === "string" && `${error.code}: ${error.message}`) ||
      sanitizeErrorMessage(error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: detail },
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
