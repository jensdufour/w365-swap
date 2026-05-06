/**
 * Lightweight HTTP error type for API handlers. Wrap thrown errors with a
 * status code + safe message; everything else collapses to 500.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

import type { HttpResponseInit } from "@azure/functions";

export function httpResponseFromError(err: unknown): HttpResponseInit {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      jsonBody: { error: err.message },
    };
  }
  // Don't leak internals to callers.
  // Workers logs (App Insights once wired) capture the real stack.
  console.error("Unhandled error in handler", err);
  return {
    status: 500,
    jsonBody: { error: "Internal server error" },
  };
}
