import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";
import { isValidGuid, sanitizeErrorMessage } from "../lib/validation.js";

/**
 * GET /api/cloudpcs
 * Lists Cloud PCs assigned to the authenticated user.
 *
 * Uses Graph `/me/cloudPCs` so callers only ever see their own devices,
 * regardless of whether their token has tenant-wide Cloud PC permissions.
 *
 * Query params:
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

    // Only the caller's own Cloud PCs — never the whole tenant.
    const response = await client
      .api("/me/cloudPCs")
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

// NOTE: POST /api/cloudpcs/:id/restore is registered in actions.ts.
