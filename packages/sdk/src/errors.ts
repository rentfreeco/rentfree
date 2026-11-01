/** One problem with a request, as the api names it. */
export interface Issue {
  path: string;
  message: string;
}

/**
 * The api answered with an error. `code` is the api's `error`, such as
 * `not_found` or `collection_archived`; the contract lists every code each
 * route can answer.
 */
export class RentfreeError extends Error {
  override readonly name = "RentfreeError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues: readonly Issue[] = [],
    /** The route that answered, by its contract id. */
    readonly route?: string,
  ) {
    super(
      issues.length
        ? `${code}: ${issues
            .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
            .join("; ")}`
        : `${code} (HTTP ${status})`,
    );
  }
}

/** The request never got an answer: the network failed, or it was aborted. */
export class RentfreeUnreachable extends Error {
  override readonly name = "RentfreeUnreachable";
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(
      `Could not reach ${url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/** A wait for work in the background gave up before the work finished. */
export class RentfreeTimeout extends Error {
  override readonly name = "RentfreeTimeout";
  constructor(
    readonly what: string,
    readonly waitedMs: number,
  ) {
    super(`Gave up waiting for ${what} after ${Math.round(waitedMs / 1000)}s`);
  }
}

/** Reads an error body leniently: whatever the server sent, a code comes out. */
export function errorFrom(
  status: number,
  body: unknown,
  route?: string,
): RentfreeError {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const issues = Array.isArray(record.issues)
    ? record.issues.flatMap((issue): Issue[] =>
        typeof issue === "object" && issue !== null
          ? [
              {
                path: String((issue as Record<string, unknown>).path ?? ""),
                message: String(
                  (issue as Record<string, unknown>).message ?? "",
                ),
              },
            ]
          : [],
      )
    : [];
  return new RentfreeError(
    status,
    typeof record.error === "string" ? record.error : `http_${status}`,
    issues,
    route,
  );
}
