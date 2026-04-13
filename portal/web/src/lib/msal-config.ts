import { Configuration, LogLevel } from "@azure/msal-browser";

/**
 * MSAL configuration for W365 Swap portal.
 * 
 * Required Entra ID App Registration:
 *   - SPA redirect URI: http://localhost:3000 (dev), https://your-swa.azurestaticapps.net (prod)
 *   - API permissions: CloudPC.ReadWrite.All (delegated)
 *   - Expose an API: api://{clientId} with scope "access_as_user"
 */
export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || "",
    authority: `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_TENANT_ID || "common"}`,
    redirectUri: typeof window !== "undefined" ? window.location.origin : "",
    postLogoutRedirectUri: typeof window !== "undefined" ? window.location.origin : "",
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
      loggerCallback: (level, message) => {
        if (level === LogLevel.Error) console.error(message);
      },
    },
  },
};

/** Scopes for acquiring tokens to call our API backend (OBO flow). */
export const apiScopes = [
  `api://${process.env.NEXT_PUBLIC_AZURE_CLIENT_ID}/access_as_user`,
];

/** Scopes for direct Graph calls (if needed from frontend). */
export const graphScopes = [
  "https://graph.microsoft.com/CloudPC.ReadWrite.All",
];
