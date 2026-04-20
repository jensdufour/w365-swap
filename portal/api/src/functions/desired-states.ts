import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { extractBearerToken } from "../lib/graph-client.js";
import { sanitizeErrorMessage } from "../lib/validation.js";

/* =============================================================================
 * Desired-States (MOCK / VISION)
 *
 * This entire module simulates a capability that Windows 365 does NOT actually
 * offer today: owning one Cloud PC compute instance and attaching/detaching
 * multiple independent "desired state" OS disks to it on demand.
 *
 * Nothing here calls Graph or touches a real Cloud PC. All state is persisted
 * per-user as a single JSON index blob in a dedicated mock container so the
 * UI can round-trip create/attach/detach/delete operations and demo the UX.
 *
 * Schema (per-user index blob):
 *   {
 *     "version": 1,
 *     "states": [
 *       {
 *         "id": "<uuid>",
 *         "name": "Project Alpha",
 *         "description": "Dev environment with VS, Docker, Node 20",
 *         "sizeGB": 256,
 *         "os": "Windows 11 Enterprise 24H2",
 *         "status": "attached" | "detached",
 *         "createdAt": "<iso>",
 *         "lastAttachedAt": "<iso> | null"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Invariant: at most one state may be `attached` at a time per user. Attaching
 * a state implicitly detaches whichever state was previously attached.
 * ============================================================================= */

const MOCK_CONTAINER = "desired-states-mock";

function getStorageAccountName(): string {
  const id = process.env.STORAGE_ACCOUNT_ID || "";
  const match = id.match(/storageAccounts\/([^/]+)/i);
  return match ? match[1] : "";
}

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

function indexBlobName(oid: string): string {
  return `users/${oid}/index.json`;
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

type DesiredState = {
  id: string;
  name: string;
  description: string;
  sizeGB: number;
  os: string;
  status: "attached" | "detached";
  createdAt: string;
  lastAttachedAt: string | null;
};

type Index = { version: 1; states: DesiredState[] };

async function loadIndex(oid: string): Promise<Index> {
  const blobService = createBlobService();
  const container = blobService.getContainerClient(MOCK_CONTAINER);
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(indexBlobName(oid));
  if (!(await blob.exists())) {
    return { version: 1, states: [] };
  }
  const buf = await blob.downloadToBuffer();
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    if (parsed && Array.isArray(parsed.states)) return parsed as Index;
  } catch {
    /* fall through */
  }
  return { version: 1, states: [] };
}

async function saveIndex(oid: string, index: Index): Promise<void> {
  const blobService = createBlobService();
  const container = blobService.getContainerClient(MOCK_CONTAINER);
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(indexBlobName(oid));
  const body = Buffer.from(JSON.stringify(index), "utf8");
  await blob.upload(body, body.byteLength, {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

function uuid(): string {
  // Minimal RFC4122 v4 using crypto.randomUUID when available.
  return (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeName(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  // Printable, no control chars.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

async function requireOid(request: HttpRequest): Promise<string | HttpResponseInit> {
  const token = extractBearerToken(request.headers.get("authorization") ?? undefined);
  if (!token) {
    return { status: 401, jsonBody: { error: "Missing or invalid authorization header" } };
  }
  const oid = getCallerOid(token);
  if (!oid) {
    return { status: 401, jsonBody: { error: "Unable to determine caller identity" } };
  }
  return oid;
}

/* ----------------------------------------------------------------------------
 * Handlers
 * -------------------------------------------------------------------------- */

async function listDesiredStates(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const oidOrErr = await requireOid(request);
  if (typeof oidOrErr !== "string") return oidOrErr;

  try {
    const index = await loadIndex(oidOrErr);
    return { status: 200, jsonBody: { data: index.states, meta: { mock: true } } };
  } catch (error: any) {
    context.error("Failed to list desired states:", error);
    return { status: 500, jsonBody: { error: sanitizeErrorMessage(error) } };
  }
}

async function createDesiredState(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const oidOrErr = await requireOid(request);
  if (typeof oidOrErr !== "string") return oidOrErr;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const name = sanitizeName(body?.name);
  if (!name) {
    return { status: 400, jsonBody: { error: "name is required (1-80 printable chars)" } };
  }
  const description = sanitizeName(body?.description, 240) ?? "";
  const sizeGB = Number.isFinite(body?.sizeGB) ? Math.max(64, Math.min(2048, Math.round(body.sizeGB))) : 256;
  const os = sanitizeName(body?.os, 120) ?? "Windows 11 Enterprise 24H2";

  try {
    const index = await loadIndex(oidOrErr);
    const state: DesiredState = {
      id: uuid(),
      name,
      description,
      sizeGB,
      os,
      status: "detached",
      createdAt: new Date().toISOString(),
      lastAttachedAt: null,
    };
    index.states.unshift(state);
    await saveIndex(oidOrErr, index);
    return { status: 201, jsonBody: { data: state, meta: { mock: true } } };
  } catch (error: any) {
    context.error("Failed to create desired state:", error);
    return { status: 500, jsonBody: { error: sanitizeErrorMessage(error) } };
  }
}

async function attachDesiredState(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const oidOrErr = await requireOid(request);
  if (typeof oidOrErr !== "string") return oidOrErr;

  const id = request.params.id;
  if (!id) return { status: 400, jsonBody: { error: "id is required" } };

  try {
    const index = await loadIndex(oidOrErr);
    const target = index.states.find((s) => s.id === id);
    if (!target) return { status: 404, jsonBody: { error: "Desired state not found" } };

    const now = new Date().toISOString();
    for (const s of index.states) {
      s.status = s.id === id ? "attached" : "detached";
    }
    target.lastAttachedAt = now;
    await saveIndex(oidOrErr, index);
    return { status: 200, jsonBody: { data: target, meta: { mock: true } } };
  } catch (error: any) {
    context.error("Failed to attach desired state:", error);
    return { status: 500, jsonBody: { error: sanitizeErrorMessage(error) } };
  }
}

async function detachDesiredState(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const oidOrErr = await requireOid(request);
  if (typeof oidOrErr !== "string") return oidOrErr;

  const id = request.params.id;
  if (!id) return { status: 400, jsonBody: { error: "id is required" } };

  try {
    const index = await loadIndex(oidOrErr);
    const target = index.states.find((s) => s.id === id);
    if (!target) return { status: 404, jsonBody: { error: "Desired state not found" } };
    target.status = "detached";
    await saveIndex(oidOrErr, index);
    return { status: 200, jsonBody: { data: target, meta: { mock: true } } };
  } catch (error: any) {
    context.error("Failed to detach desired state:", error);
    return { status: 500, jsonBody: { error: sanitizeErrorMessage(error) } };
  }
}

async function deleteDesiredState(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const oidOrErr = await requireOid(request);
  if (typeof oidOrErr !== "string") return oidOrErr;

  const id = request.params.id;
  if (!id) return { status: 400, jsonBody: { error: "id is required" } };

  try {
    const index = await loadIndex(oidOrErr);
    const before = index.states.length;
    index.states = index.states.filter((s) => s.id !== id);
    if (index.states.length === before) {
      return { status: 404, jsonBody: { error: "Desired state not found" } };
    }
    await saveIndex(oidOrErr, index);
    return { status: 200, jsonBody: { data: { id, deleted: true }, meta: { mock: true } } };
  } catch (error: any) {
    context.error("Failed to delete desired state:", error);
    return { status: 500, jsonBody: { error: sanitizeErrorMessage(error) } };
  }
}

/* ----------------------------------------------------------------------------
 * Route registration
 * -------------------------------------------------------------------------- */

app.http("listDesiredStates", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "desired-states",
  handler: listDesiredStates,
});

app.http("createDesiredState", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "desired-states",
  handler: createDesiredState,
});

app.http("attachDesiredState", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "desired-states/{id}/attach",
  handler: attachDesiredState,
});

app.http("detachDesiredState", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "desired-states/{id}/detach",
  handler: detachDesiredState,
});

app.http("deleteDesiredState", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "desired-states/{id}",
  handler: deleteDesiredState,
});
