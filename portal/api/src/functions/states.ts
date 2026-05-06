import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { authenticate } from "../lib/auth";
import { containers } from "../lib/cosmos";
import { generateDek, wrapDek, unwrapDek } from "../lib/crypto";
import { HttpError, httpResponseFromError } from "../lib/http";
import type { StateRecord } from "../lib/types";

/** GET /api/states — list the caller's saved states (newest first). */
async function listStates(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const { resources } = await containers
      .states()
      .items.query<StateRecord>(
        {
          query: "SELECT * FROM c WHERE c.userId = @uid ORDER BY c.createdAt DESC",
          parameters: [{ name: "@uid", value: auth.userId }],
        },
        { partitionKey: auth.userId },
      )
      .fetchAll();
    // Strip wrappedDek from list responses — agent only needs it on demand
    // via /states/{id}/dek so we never accidentally log it in transit.
    const safe = resources.map(({ wrappedDek: _w, ...rest }) => rest);
    return { status: 200, jsonBody: { states: safe } };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

/**
 * POST /api/states — begin a new save. Generates a fresh DEK, wraps it with
 * the customer's KEK, and stores the wrapped form on the StateRecord. The
 * plaintext DEK is never persisted; the agent fetches it on demand via
 * /states/{id}/dek for the encrypt or decrypt operation.
 */
async function createState(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const body = (await req.json().catch(() => null)) as Partial<StateRecord> | null;

    const dek = generateDek();
    const { wrapped, kekKid } = await wrapDek(dek);
    // Defensive: drop the plaintext DEK from memory ASAP. Node won't actually
    // zeroize the buffer (GC opaque), but at least we don't keep a reference.
    dek.fill(0);

    const record: StateRecord = {
      id: randomUUID(),
      userId: auth.userId,
      manifestVersion: body?.manifestVersion ?? "0",
      createdAt: new Date().toISOString(),
      status: "pending",
      label: typeof body?.label === "string" ? body.label : undefined,
      cloudPcId: typeof body?.cloudPcId === "string" ? body.cloudPcId : undefined,
      wrappedDek: wrapped,
      kekKid,
      dekAlgorithm: "AES-256-GCM",
    };

    const { resource } = await containers.states().items.create(record);
    // Strip wrappedDek from the create response too — agent must call
    // /states/{id}/dek explicitly.
    if (resource) {
      const { wrappedDek: _w, ...safe } = resource;
      return { status: 201, jsonBody: safe };
    }
    return { status: 201, jsonBody: record };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

/** GET /api/states/{id} — read a single state record (caller's only). */
async function getState(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const id = req.params.id;
    if (!id) throw new HttpError(400, "Missing id");

    const { resource } = await containers
      .states()
      .item(id, auth.userId)
      .read<StateRecord>();
    if (!resource) throw new HttpError(404, "Not found");
    // Same: never echo wrappedDek on the metadata path.
    const { wrappedDek: _w, ...safe } = resource;
    return { status: 200, jsonBody: safe };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

/**
 * POST /api/states/{id}/dek — return the plaintext DEK for a state, base64.
 *
 * The agent calls this once per encrypt or decrypt operation. The DEK
 * crosses TLS to the agent; the agent uses it for AES-GCM and discards it.
 *
 * Authorisation: the caller must own the StateRecord. Cosmos partition-key
 * lookup with `(id, userId)` enforces this — a different user's request
 * 404s instead of leaking a record's existence.
 */
async function getStateDek(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const id = req.params.id;
    if (!id) throw new HttpError(400, "Missing id");

    const { resource } = await containers
      .states()
      .item(id, auth.userId)
      .read<StateRecord>();
    if (!resource) throw new HttpError(404, "Not found");
    if (!resource.wrappedDek || !resource.kekKid) {
      throw new HttpError(409, "State has no DEK envelope");
    }

    const dek = await unwrapDek(resource.wrappedDek, resource.kekKid);
    const dekB64 = dek.toString("base64");
    dek.fill(0);

    return {
      status: 200,
      jsonBody: {
        dek: dekB64,
        algorithm: resource.dekAlgorithm ?? "AES-256-GCM",
        kekKid: resource.kekKid,
      },
    };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

app.http("listStates", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "states",
  handler: listStates,
});

app.http("createState", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "states",
  handler: createState,
});

app.http("getState", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "states/{id}",
  handler: getState,
});

app.http("getStateDek", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "states/{id}/dek",
  handler: getStateDek,
});
