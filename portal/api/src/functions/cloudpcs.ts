import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";
import { isValidGuid, sanitizeErrorMessage } from "../lib/validation.js";

/**
 * GET /api/cloudpcs
 * Lists Cloud PCs for the authenticated user, or all if admin and ?all=true.
 * 
 * Query params:
 *   - all=true: list all Cloud PCs (requires admin)
 *   - includeSnapshots=true: also retrieve snapshots per CPC
 */
async function getCloudPCs(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  try {
    const client = createOboGraphClient(token);
    const includeSnapshots = request.query.get("includeSnapshots") === "true";

    // Get Cloud PCs
    const response = await client
      .api("/deviceManagement/virtualEndpoint/cloudPCs")
      .version("beta")
      .get();

    const cloudPCs = response.value || [];

    // Optionally enrich with snapshots
    if (includeSnapshots) {
      for (const cpc of cloudPCs) {
        try {
          const snapResponse = await client
            .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cpc.id}/retrieveSnapshots`)
            .version("beta")
            .get();
          cpc.snapshots = snapResponse.value || [];
        } catch {
          cpc.snapshots = [];
        }
      }
    }

    return { status: 200, jsonBody: { data: cloudPCs } };
  } catch (error: any) {
    context.error("Failed to get Cloud PCs:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

app.http("getCloudPCs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cloudpcs",
  handler: getCloudPCs,
});

/**
 * POST /api/cloudpcs/:id/restore
 * Restores a Cloud PC in place to one of its own W365-retained snapshots.
 *
 * Body:
 *   - snapshotId: ID of the cloudPcSnapshot to restore to (required)
 *
 * This is the "true" load-onto-existing-CPC workflow. It uses only W365's
 * in-service snapshots (not VHDs in customer storage); the CPC is not
 * re-provisioned, so the license/assignment/policy binding all persist.
 * Any local state created after the snapshot will be lost.
 */
async function restoreCloudPC(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const cloudPcId = request.params.id;
  if (!isValidGuid(cloudPcId)) {
    return { status: 400, jsonBody: { error: "Invalid Cloud PC ID format" } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : undefined;
  if (!snapshotId) {
    return { status: 400, jsonBody: { error: "snapshotId is required" } };
  }
  // Snapshot IDs look like "CPC_<cloudPcId>_<guid>"; validate the shape loosely.
  if (!/^[A-Za-z0-9_\-.]+$/.test(snapshotId) || snapshotId.length > 256) {
    return { status: 400, jsonBody: { error: "Invalid snapshotId format" } };
  }

  try {
    const client = createOboGraphClient(token);
    await client
      .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}/restore`)
      .version("beta")
      .post({ cloudPcSnapshotId: snapshotId });

    return {
      status: 202,
      jsonBody: {
        data: {
          cloudPcId,
          snapshotId,
          status: "restoring",
          message: "Restore initiated. The Cloud PC will be unavailable for 5-15 minutes.",
        },
      },
    };
  } catch (error: any) {
    context.error("Failed to restore Cloud PC:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

app.http("restoreCloudPC", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}/restore",
  handler: restoreCloudPC,
});
