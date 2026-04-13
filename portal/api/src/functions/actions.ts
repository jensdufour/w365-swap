import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";

/**
 * POST /api/cloudpcs/:id/restore
 * Restores a Cloud PC to a previous snapshot.
 * 
 * Body:
 *   - snapshotId: the snapshot ID to restore to
 */
async function restoreCloudPC(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const cloudPcId = request.params.id;
  if (!cloudPcId) {
    return { status: 400, jsonBody: { error: "Cloud PC ID is required" } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const snapshotId = body.snapshotId as string;
  if (!snapshotId) {
    return { status: 400, jsonBody: { error: "snapshotId is required in request body" } };
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
          status: "inProgress",
          message: "Restore initiated. The user will be disconnected during the restore process (estimated 5-15 minutes).",
        },
      },
    };
  } catch (error: any) {
    context.error("Failed to restore Cloud PC:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || "Failed to restore Cloud PC" },
    };
  }
}

/**
 * POST /api/cloudpcs/:id/power
 * Powers on or off a Cloud PC (Frontline only).
 * 
 * Body:
 *   - action: "start" | "stop"
 */
async function powerAction(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const cloudPcId = request.params.id;
  if (!cloudPcId) {
    return { status: 400, jsonBody: { error: "Cloud PC ID is required" } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const action = body.action as string;
  if (!action || !["start", "stop"].includes(action)) {
    return { status: 400, jsonBody: { error: "action must be 'start' or 'stop'" } };
  }

  try {
    const client = createOboGraphClient(token);

    await client
      .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}/${action}`)
      .version("beta")
      .post(undefined);

    return {
      status: 202,
      jsonBody: {
        data: {
          cloudPcId,
          action,
          status: "inProgress",
          message: `${action === "start" ? "Power on" : "Power off"} initiated.`,
        },
      },
    };
  } catch (error: any) {
    context.error(`Failed to ${action} Cloud PC:`, error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: error.message || `Failed to ${action} Cloud PC` },
    };
  }
}

app.http("restoreCloudPC", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}/restore",
  handler: restoreCloudPC,
});

app.http("powerAction", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}/power",
  handler: powerAction,
});
