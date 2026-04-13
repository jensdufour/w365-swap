/**
 * Input validation helpers for W365 Swap API.
 * Prevents injection and path traversal attacks.
 */

const GUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const AZURE_RESOURCE_ID_PATTERN = /^\/subscriptions\/[0-9a-fA-F-]+\/resourceGroups\/[\w.\-]+\/providers\/[\w.]+\/[\w]+\/[\w\-]+$/;
const BLOB_NAME_PATTERN = /^[a-zA-Z0-9_\-./]+$/;
const ACCESS_TIER_VALUES = ["hot", "cool", "cold", "archive"] as const;

export function isValidGuid(value: string | undefined | null): value is string {
  return typeof value === "string" && GUID_PATTERN.test(value);
}

export function isValidAzureResourceId(value: string | undefined | null): value is string {
  return typeof value === "string" && AZURE_RESOURCE_ID_PATTERN.test(value);
}

export function isValidBlobName(value: string | undefined | null): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && BLOB_NAME_PATTERN.test(value);
}

export function isValidAccessTier(value: string | undefined | null): value is typeof ACCESS_TIER_VALUES[number] {
  return typeof value === "string" && (ACCESS_TIER_VALUES as readonly string[]).includes(value);
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Strip potential sensitive info from error messages before returning to client
    return error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  }
  return "An unexpected error occurred";
}
