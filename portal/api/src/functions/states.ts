import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { authenticate } from "../lib/auth";
import { containers } from "../lib/cosmos";
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
    return { status: 200, jsonBody: { states: resources } };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

/**
 * POST /api/states — begin a new save. Returns an empty pending record; the
 * agent uploads chunks (via /chunks/upload-sas) and then commits.
 */
async function createState(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const body = (await req.json().catch(() => null)) as Partial<StateRecord> | null;

    const record: StateRecord = {
      id: randomUUID(),
      userId: auth.userId,
      manifestVersion: body?.manifestVersion ?? "0",
      createdAt: new Date().toISOString(),
      status: "pending",
      label: typeof body?.label === "string" ? body.label : undefined,
      cloudPcId: typeof body?.cloudPcId === "string" ? body.cloudPcId : undefined,
    };

    const { resource } = await containers.states().items.create(record);
    return { status: 201, jsonBody: resource };
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
    return { status: 200, jsonBody: resource };
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
