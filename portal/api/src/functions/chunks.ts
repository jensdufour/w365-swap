import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authenticate } from "../lib/auth";
import { HttpError, httpResponseFromError } from "../lib/http";
import { mintDownloadSAS, mintUploadSAS } from "../lib/storage";

const HASH_RE = /^[a-f0-9]{64}$/i;

/**
 * POST /api/chunks/upload-sas
 * Body: { hash: string }
 * Returns a short-lived user-delegation SAS the agent PUTs the (encrypted)
 * chunk to. Service never sees plaintext.
 */
async function uploadSas(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const body = (await req.json().catch(() => null)) as { hash?: string } | null;
    if (!body?.hash || !HASH_RE.test(body.hash)) {
      throw new HttpError(400, "Body requires hash (64 hex chars, BLAKE3)");
    }
    const sas = await mintUploadSAS(auth.userId, body.hash.toLowerCase());
    return { status: 200, jsonBody: sas };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

/**
 * GET /api/chunks/{hash}/download-sas
 * Returns a short-lived read SAS the agent uses during restore.
 */
async function downloadSas(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticate(req);
    const hash = req.params.hash;
    if (!hash || !HASH_RE.test(hash)) {
      throw new HttpError(400, "Invalid hash");
    }
    const sas = await mintDownloadSAS(auth.userId, hash.toLowerCase());
    return { status: 200, jsonBody: sas };
  } catch (err) {
    return httpResponseFromError(err);
  }
}

app.http("chunkUploadSas", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "chunks/upload-sas",
  handler: uploadSas,
});

app.http("chunkDownloadSas", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "chunks/{hash}/download-sas",
  handler: downloadSas,
});
