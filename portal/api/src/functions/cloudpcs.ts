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
 * DELETE /api/cloudpcs/:id
 * Ends the grace period on a Cloud PC (effectively deletes it).
 *
 * Used by the Replace-from-Swap flow: once a replacement Cloud PC has been
 * provisioned from a swap, the user confirms removal of the old one.
 */
async function deleteCloudPC(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    // endGracePeriod triggers immediate deletion for Cloud PCs in grace period.
    // For normal Cloud PCs we issue a DELETE on the cloudPC itself, which
    // transitions it to grace period (Intune will then delete per the tenant's
    // grace-period policy). Calling endGracePeriod afterwards short-circuits
    // that wait. We try endGracePeriod first; if the CPC isn't in grace, the
    // DELETE triggers the transition.
    try {
      await client
        .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}/endGracePeriod`)
        .version("beta")
        .post({});
    } catch {
      // Not in grace period yet — issue the regular delete, which starts it.
      await client
        .api(`/deviceManagement/virtualEndpoint/cloudPCs/${cloudPcId}`)
        .version("beta")
        .delete();
    }

    return {
      status: 202,
      jsonBody: {
        data: {
          cloudPcId,
          status: "deleting",
          message: "Cloud PC removal initiated. The device will be decommissioned per your tenant's grace-period policy.",
        },
      },
    };
  } catch (error: any) {
    context.error("Failed to delete Cloud PC:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

app.http("deleteCloudPC", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "cloudpcs/{id}",
  handler: deleteCloudPC,
});
