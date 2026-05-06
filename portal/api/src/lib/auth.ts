import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HttpRequest } from "@azure/functions";
import { HttpError } from "./http";
import type { AuthContext } from "./types";

// Use MOSAIC_-prefixed env var names: the Azure SDK's DefaultAzureCredential
// reads AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET to do
// EnvironmentCredential auth. If those are present, the Cosmos/Storage
// clients authenticate as our SPA service principal instead of the Function
// App managed identity, breaking RBAC. Keep these scoped to JWT validation.
const tenantId = process.env.MOSAIC_TENANT_ID;
const clientId = process.env.MOSAIC_API_CLIENT_ID;

if (!tenantId || !clientId) {
  // Don't crash module load; functions will emit 500 if invoked.
  console.warn("MOSAIC_TENANT_ID or MOSAIC_API_CLIENT_ID missing — auth will fail.");
}

const ISSUER = tenantId ? `https://login.microsoftonline.com/${tenantId}/v2.0` : undefined;
// Accept both forms of the audience claim:
//   - v1 tokens: "api://{clientId}" (App ID URI)
//   - v2 tokens: "{clientId}" (bare GUID — Microsoft's v2 normalization)
// The Entra app is configured for v2 tokens (requestedAccessTokenVersion=2)
// but we accept v1 too for forward/backward compatibility.
const AUDIENCE = clientId ? [clientId, `api://${clientId}`] : undefined;

const jwks = tenantId
  ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`))
  : null;

/**
 * Validate the Bearer token on `req`. Verifies signature, issuer, audience,
 * expiry. Returns extracted identity or throws HttpError 401.
 */
export async function authenticate(req: HttpRequest): Promise<AuthContext> {
  if (!jwks || !ISSUER || !AUDIENCE) {
    throw new HttpError(500, "Auth not configured");
  }

  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Missing bearer token");
  }
  const token = header.slice(7).trim();

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(401, "Invalid token");
  }

  const userId = payload.oid as string | undefined;
  const tid = payload.tid as string | undefined;
  if (!userId || !tid) {
    throw new HttpError(401, "Token missing required claims (oid, tid)");
  }

  return {
    userId,
    tenantId: tid,
    upn: typeof payload.upn === "string" ? (payload.upn as string) : undefined,
  };
}
