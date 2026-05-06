import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";
import { isValidGuid, sanitizeErrorMessage } from "../lib/validation.js";

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

app.http("getSnapshots", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}/snapshots",
  handler: getSnapshots,
});
