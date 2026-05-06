import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HttpRequest } from "@azure/functions";
import { HttpError } from "./http";
import type { AuthContext } from "./types";

const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;

if (!tenantId || !clientId) {
  // Don't crash module load; functions will emit 500 if invoked.
  console.warn("AZURE_TENANT_ID or AZURE_CLIENT_ID missing — auth will fail.");
}

const ISSUER = tenantId ? `https://login.microsoftonline.com/${tenantId}/v2.0` : undefined;
const AUDIENCE = clientId ? `api://${clientId}` : undefined;

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
