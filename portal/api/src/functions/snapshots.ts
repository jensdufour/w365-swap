import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";
import { isValidGuid, isValidAzureResourceId, isValidAccessTier, sanitizeErrorMessage } from "../lib/validation.js";

/**
 * GET /api/cloudpcs/:id/snapshots
 * Lists snapshots for a specific Cloud PC.
 */
async function getSnapshots(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const cloudPcId = request.params.id;
  if (!isValidGuid(cloudPcId)) {
    return { status: 400, jsonBody: { error: "Invalid Cloud PC ID format" } };
  }

  try {
    const client = createOboGraphClient(token);
    const response = await client
      .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}/retrieveSnapshots`)
      .version("beta")
      .get();

    return { status: 200, jsonBody: { data: response.value || [] } };
  } catch (error: any) {
    context.error("Failed to get snapshots:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

/**
 * POST /api/cloudpcs/:id/snapshots
 * Creates a manual snapshot for a Cloud PC.
 * 
 * Body (optional):
 *   - storageAccountId: Azure resource ID for customer-managed storage
 *   - accessTier: hot | cool | cold | archive
 */
async function createSnapshot(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const cloudPcId = request.params.id;
  if (!isValidGuid(cloudPcId)) {
    return { status: 400, jsonBody: { error: "Invalid Cloud PC ID format" } };
  }

  try {
    const client = createOboGraphClient(token);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const requestBody: Record<string, unknown> = {};
    if (body.storageAccountId) {
      if (!isValidAzureResourceId(body.storageAccountId as string)) {
        return { status: 400, jsonBody: { error: "Invalid storageAccountId format" } };
      }
      requestBody.storageAccountId = body.storageAccountId;
    }
    if (body.accessTier) {
      if (!isValidAccessTier(body.accessTier as string)) {
        return { status: 400, jsonBody: { error: "Invalid accessTier. Must be hot, cool, cold, or archive" } };
      }
      requestBody.accessTier = body.accessTier;
    }

    await client
      .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}/createSnapshot`)
      .version("beta")
      .post(Object.keys(requestBody).length > 0 ? requestBody : undefined);

    return {
      status: 202,
      jsonBody: {
        data: {
          cloudPcId,
          status: "inProgress",
          message: "Snapshot creation initiated",
        },
      },
    };
  } catch (error: any) {
    context.error("Failed to create snapshot:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

app.http("getSnapshots", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}/snapshots",
  handler: getSnapshots,
});

app.http("createSnapshot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}/snapshots",
  handler: createSnapshot,
});
