/**
 * Which requests carry an Idempotency-Key. Kept apart from the schemas, and
 * free of zod, so the client can use it without loading them.
 */

/** POSTs under `/v1` that only read, and so need no idempotency key. */
export const READ_ONLY_POSTS = ["/v1/search", "/v1/context"] as const;

/** Whether a route needs an `Idempotency-Key` header: every POST under `/v1` but the reads. */
export function needsIdempotencyKey(spec: { method: string; path: string }) {
  return (
    spec.method === "post" &&
    spec.path.startsWith("/v1/") &&
    !(READ_ONLY_POSTS as readonly string[]).includes(spec.path)
  );
}
