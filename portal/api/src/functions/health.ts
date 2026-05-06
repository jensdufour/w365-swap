import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

/**
 * Liveness probe for the Mosaic Catalog API.
 *
 * Intentionally minimal: the v0 endpoints (states, chunks, agent-policy,
 * admin) are still being scaffolded. This stub keeps the Functions host
 * happy with at least one registered function so deploys succeed.
 */
async function health(_req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: {
      status: "ok",
      service: "mosaic-api",
      version: "0.0.0",
    },
  };
}

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: health,
});
