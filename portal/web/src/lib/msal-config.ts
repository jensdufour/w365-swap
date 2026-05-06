import { Configuration, LogLevel } from "@azure/msal-browser";

/**
 * MSAL configuration for the Mosaic portal.
 *
 * Required Entra ID app registration:
 *   - SPA redirect URI: http://localhost:3000 (dev), the SWA URL (prod),
 *     plus any custom domains (declared in azd via AZURE_EXTRA_REDIRECT_URIS).
 *   - Expose an API: api://{clientId} with scope "access_as_user".
 *
 * Mosaic does not call Microsoft Graph from the portal in MVP — all backend
 * traffic is to our own Catalog API.
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

/** Scopes for acquiring tokens to call the Mosaic Catalog API (OBO flow). */
export const apiScopes = [
  `api://${process.env.NEXT_PUBLIC_AZURE_CLIENT_ID}/access_as_user`,
];
