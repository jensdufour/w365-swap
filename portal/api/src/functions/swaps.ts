import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { createOboGraphClient, extractBearerToken } from "../lib/graph-client.js";
import { sanitizeErrorMessage } from "../lib/validation.js";

// Containers we scan for exported Cloud PC VHDs. Windows 365 creates its own
// per-tenant share container when exporting via Graph createSnapshot (name
// pattern "windows365-share-ent-<suffix>"), so we include any container whose
// name matches that prefix in addition to the manually-provisioned "snapshots"
// container.
const MANAGED_CONTAINER = "snapshots";
const W365_CONTAINER_PREFIX = "windows365-share-";

// Blob metadata key where we persist the user-supplied display name. Metadata
// values are ASCII only, so we store a base64(UTF-8) payload.
const DISPLAY_NAME_META_KEY = "displayname_b64";

// Blob metadata key for the owning user's Entra object id (oid). Stamped when
// a caller first claims a legacy (unclaimed) swap, or on save/rename/delete.
// Lowercase GUID; fits in ASCII so no encoding is needed.
const OWNER_OID_META_KEY = "owner_oid";

function getStorageAccountName(): string {
  const id = process.env.STORAGE_ACCOUNT_ID || "";
  const match = id.match(/storageAccounts\/([^/]+)/i);
  return match ? match[1] : "";
}

function isSwapContainer(name: string): boolean {
  return name === MANAGED_CONTAINER || name.startsWith(W365_CONTAINER_PREFIX);
}

function isValidContainerName(name: string): boolean {
  // Azure container names: 3–63 chars, lowercase alphanumeric and hyphens.
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name);
}

function isValidSwapBlobName(name: string): boolean {
  if (!name || name.length > 1024) return false;
  if (name.includes("..")) return false;
  return /^[a-zA-Z0-9_\-./]+$/.test(name);
}

function decodeDisplayName(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function encodeDisplayName(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function extractCpcIdFromBlobName(blobName: string): string | null {
  const base = blobName.replace(/^.*\//, "");
  const match = base.match(/^CPC_([0-9a-fA-F-]{36})_/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extracts the caller's Entra object id (`oid`) from the JWT in the
 * Authorization header. Falls back to `sub` if `oid` is absent. This is only
 * used to tag blob ownership metadata - scoping decisions never trust it in
 * isolation (Graph calls via OBO remain the authoritative source).
 */
function getCallerOid(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    const oid = typeof payload.oid === "string" ? payload.oid : payload.sub;
    return typeof oid === "string" ? oid.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Returns the companion blob name (.vmgs alongside .vhdx, or vice-versa). */
function companionBlobName(blobName: string): string | null {
  if (/\.vhdx?$/i.test(blobName)) {
    return blobName.replace(/\.vhdx?$/i, ".vmgs");
  }
  if (/\.vmgs$/i.test(blobName)) {
    return blobName.replace(/\.vmgs$/i, ".vhdx");
  }
  return null;
}

function createBlobService(): BlobServiceClient {
  const accountName = getStorageAccountName();
  if (!accountName) {
    throw new Error("Storage account not configured");
  }
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new ManagedIdentityCredential(),
  );
}

/**
 * Returns the set of Cloud PC ids (lowercase) assigned to the signed-in user.
 * Used to scope swap list/modify operations to the caller's own devices.
 */
async function getCallerCpcIds(token: string): Promise<Set<string>> {
  const client = createOboGraphClient(token);
  const response = await client.api("/me/cloudPCs").version("beta").get();
  const ids = new Set<string>();
  for (const cpc of response?.value ?? []) {
    if (typeof cpc?.id === "string") ids.add(cpc.id.toLowerCase());
  }
  return ids;
}

/**
 * GET /api/swaps
 * Lists the caller's saved swaps. A swap is "the caller's" when:
 *   - its `owner_oid` metadata equals the caller's oid, OR
 *   - it has no `owner_oid` set (legacy / unclaimed) AND either matches one
 *     of the caller's currently-assigned Cloud PCs by id prefix, or has no
 *     parseable CPC id at all.
 *
 * When a caller reads a legacy blob that maps to one of their CPCs, we stamp
 * their oid as owner so future reads are unambiguous (best-effort; errors
 * are logged and ignored).
 */
async function listSwaps(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const callerOid = getCallerOid(token);

  try {
    const callerCpcIds = await getCallerCpcIds(token);
    const blobService = createBlobService();

    const swaps: Array<{
      name: string;
      containerName: string;
      displayName: string | null;
      cloudPcId: string | null;
      size: number;
      createdOn: string;
      accessTier: string | undefined;
      contentType: string | undefined;
    }> = [];

    for await (const container of blobService.listContainers()) {
      if (!isSwapContainer(container.name)) continue;

      const containerClient = blobService.getContainerClient(container.name);
      for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
        if (!/\.vhdx?$/i.test(blob.name)) continue;

        const meta = blob.metadata ?? {};
        const ownerOid = typeof meta[OWNER_OID_META_KEY] === "string" ? meta[OWNER_OID_META_KEY].toLowerCase() : null;
        const cpcId = extractCpcIdFromBlobName(blob.name);
        const ownedByCaller = !!(callerOid && ownerOid && ownerOid === callerOid);
        const legacyMatchesCpc = !ownerOid && (cpcId ? callerCpcIds.has(cpcId) : true);

        if (!ownedByCaller && !legacyMatchesCpc) continue;

        // Lazy claim: if this is a legacy blob that matches the caller's CPC
        // and we know the caller's oid, stamp ownership so it's stable going
        // forward. Best-effort; ignore failures.
        if (!ownerOid && callerOid && legacyMatchesCpc) {
          try {
            const blobClient = containerClient.getBlobClient(blob.name);
            await blobClient.setMetadata({ ...meta, [OWNER_OID_META_KEY]: callerOid });
          } catch (err) {
            context.warn(`Failed to stamp owner on ${blob.name}: ${(err as Error).message}`);
          }
        }

        swaps.push({
          name: blob.name,
          containerName: container.name,
          displayName: decodeDisplayName(meta[DISPLAY_NAME_META_KEY]),
          cloudPcId: cpcId,
          size: blob.properties.contentLength || 0,
          createdOn: blob.properties.createdOn?.toISOString() || "",
          accessTier: blob.properties.accessTier,
          contentType: blob.properties.contentType,
        });
      }
    }

    swaps.sort((a, b) => new Date(b.createdOn).getTime() - new Date(a.createdOn).getTime());

    return { status: 200, jsonBody: { data: swaps } };
  } catch (error: any) {
    context.error("Failed to list swaps:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: "Failed to list saved swaps. The storage account may not be accessible." },
    };
  }
}

/**
 * Validates the URL-path container + blob pair and checks that the blob
 * belongs to the caller. Ownership is resolved in the same way as listSwaps:
 * owner metadata match, or legacy blob matching one of the caller's CPCs.
 */
async function resolveCallerOwnedBlob(
  token: string,
  container: string,
  blobName: string,
): Promise<
  | { ok: true; containerClient: ContainerClient; cpcId: string | null; ownerOid: string | null }
  | { ok: false; response: HttpResponseInit }
> {
  if (!isValidContainerName(container) || !isSwapContainer(container)) {
    return { ok: false, response: { status: 400, jsonBody: { error: "Invalid container" } } };
  }
  if (!isValidSwapBlobName(blobName)) {
    return { ok: false, response: { status: 400, jsonBody: { error: "Invalid blob name" } } };
  }

  const blobService = createBlobService();
  const containerClient = blobService.getContainerClient(container);
  const blobClient = containerClient.getBlobClient(blobName);

  const props = await blobClient.getProperties().catch((err) => {
    if (err.statusCode === 404) return null;
    throw err;
  });
  if (!props) {
    return { ok: false, response: { status: 404, jsonBody: { error: "Swap not found" } } };
  }

  const meta = props.metadata ?? {};
  const ownerOid = typeof meta[OWNER_OID_META_KEY] === "string" ? meta[OWNER_OID_META_KEY].toLowerCase() : null;
  const callerOid = getCallerOid(token);
  const cpcId = extractCpcIdFromBlobName(blobName);

  if (ownerOid) {
    if (!callerOid || ownerOid !== callerOid) {
      return { ok: false, response: { status: 404, jsonBody: { error: "Swap not found" } } };
    }
  } else {
    // Legacy blob: require the embedded CPC id to map to one of the caller's
    // current CPCs. If there is no CPC id at all, allow (and claim).
    if (cpcId) {
      const callerCpcIds = await getCallerCpcIds(token);
      if (!callerCpcIds.has(cpcId)) {
        return { ok: false, response: { status: 404, jsonBody: { error: "Swap not found" } } };
      }
    }
  }

  return { ok: true, containerClient, cpcId, ownerOid };
}

/**
 * DELETE /api/swaps/{container}/{*blobName}
 * Deletes the VHD (or VHDx) blob along with its companion guest-state (.vmgs)
 * blob if one exists. Scoped to swaps belonging to the caller.
 */
async function deleteSwap(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  const container = request.params.container;
  const blobName = request.params.blobName;

  try {
    const resolved = await resolveCallerOwnedBlob(token, container, blobName);
    if (!resolved.ok) return resolved.response;

    const { containerClient } = resolved;
    const deleted: string[] = [];

    const primary = containerClient.getBlobClient(blobName);
    const primaryResult = await primary.deleteIfExists({ deleteSnapshots: "include" });
    if (primaryResult.succeeded) deleted.push(blobName);

    const companion = companionBlobName(blobName);
    if (companion) {
      const companionClient = containerClient.getBlobClient(companion);
      const companionResult = await companionClient.deleteIfExists({ deleteSnapshots: "include" });
      if (companionResult.succeeded) deleted.push(companion);
    }

    if (deleted.length === 0) {
      return { status: 404, jsonBody: { error: "Swap not found" } };
    }

    return { status: 200, jsonBody: { data: { deleted } } };
  } catch (error: any) {
    context.error("Failed to delete swap:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

/**
 * PATCH /api/swaps/{container}/{*blobName}
 * Updates (or clears) the display-name label on a swap via blob metadata.
 * Body: { displayName: string }. Empty string clears the label.
 */
async function renameSwap(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
  if (displayName === null) {
    return { status: 400, jsonBody: { error: "displayName is required" } };
  }
  if (displayName.length > 200) {
    return { status: 400, jsonBody: { error: "displayName must be 200 characters or fewer" } };
  }

  const container = request.params.container;
  const blobName = request.params.blobName;

  try {
    const resolved = await resolveCallerOwnedBlob(token, container, blobName);
    if (!resolved.ok) return resolved.response;

    const { containerClient } = resolved;
    const blobClient = containerClient.getBlobClient(blobName);

    const existing = await blobClient.getProperties().catch((err) => {
      if (err.statusCode === 404) return null;
      throw err;
    });
    if (!existing) {
      return { status: 404, jsonBody: { error: "Swap not found" } };
    }

    const merged: Record<string, string> = { ...(existing.metadata ?? {}) };
    if (displayName === "") {
      delete merged[DISPLAY_NAME_META_KEY];
    } else {
      merged[DISPLAY_NAME_META_KEY] = encodeDisplayName(displayName);
    }

    // Stamp owner on any write if missing - renames implicitly claim.
    if (!merged[OWNER_OID_META_KEY]) {
      const callerOid = getCallerOid(token);
      if (callerOid) merged[OWNER_OID_META_KEY] = callerOid;
    }

    await blobClient.setMetadata(merged);

    return { status: 200, jsonBody: { data: { displayName: displayName || null } } };
  } catch (error: any) {
    context.error("Failed to rename swap:", error);
    return {
      status: error.statusCode || 500,
      jsonBody: { error: sanitizeErrorMessage(error) },
    };
  }
}

app.http("listSwaps", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "swaps",
  handler: listSwaps,
});

app.http("deleteSwap", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "swaps/{container}/{*blobName}",
  handler: deleteSwap,
});

app.http("renameSwap", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "swaps/{container}/{*blobName}",
  handler: renameSwap,
});
