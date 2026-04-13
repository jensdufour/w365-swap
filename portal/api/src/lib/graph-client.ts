import { ClientSecretCredential, OnBehalfOfCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import {
  TokenCredentialAuthenticationProvider,
} from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";

const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];

/**
 * Creates a Graph client using On-Behalf-Of flow.
 * The user's access token (from MSAL.js) is exchanged for a Graph token
 * via the OBO flow, preserving user context and permissions.
 */
export function createOboGraphClient(userAccessToken: string): Client {
  const tenantId = process.env.AZURE_TENANT_ID!;
  const clientId = process.env.AZURE_CLIENT_ID!;
  const clientSecret = process.env.AZURE_CLIENT_SECRET!;

  const credential = new OnBehalfOfCredential({
    tenantId,
    clientId,
    clientSecret,
    userAssertionToken: userAccessToken,
  });

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: GRAPH_SCOPES,
  });

  return Client.initWithMiddleware({ authProvider });
}

/**
 * Creates a Graph client using client credentials (app-only).
 * Used for operations that don't require user context.
 */
export function createAppGraphClient(): Client {
  const tenantId = process.env.AZURE_TENANT_ID!;
  const clientId = process.env.AZURE_CLIENT_ID!;
  const clientSecret = process.env.AZURE_CLIENT_SECRET!;

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: GRAPH_SCOPES,
  });

  return Client.initWithMiddleware({ authProvider });
}

/**
 * Extracts the bearer token from an Authorization header.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}
