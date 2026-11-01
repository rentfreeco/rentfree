import { matchRoute } from "../contract";

/** One request the fake saw. */
export interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/** A canned answer: for a route by method and path, the status and body. */
export interface Canned {
  method: string;
  /** The path under `/api`, without the query. */
  path: string;
  status: number;
  body?: unknown;
}

/**
 * A `fetch` that answers from canned responses in order. A canned success
 * must match the contract's schema for its route and status, and an error
 * the error body, so the fixtures cannot drift from what the api sends.
 */
export function fakeFetch(answers: Canned[], base = "https://api.test/api") {
  const seen: Seen[] = [];
  const queue = [...answers];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    const body =
      typeof raw === "string"
        ? (JSON.parse(raw) as unknown)
        : (raw ?? undefined);
    seen.push({ method, url, headers, body });

    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${method} ${url}`);
    const path = url.pathname.slice(new URL(base).pathname.length);
    if (
      next.method !== method ||
      next.path !== (url.origin === new URL(base).origin ? path : url.href)
    ) {
      throw new Error(
        `expected ${next.method} ${next.path}, got ${method} ${path}`,
      );
    }
    if (url.origin === new URL(base).origin) checkCanned(next, path);
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      { status: next.status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, seen, left: () => queue.length };
}

function checkCanned(canned: Canned, path: string) {
  const route = matchRoute(canned.method, path);
  if (!route)
    throw new Error(`${canned.method} ${path} is not in the contract`);
  if (canned.status >= 400) return;
  const schema = (route.responses as Record<number, unknown>)[canned.status] as
    { parse(value: unknown): unknown } | null | undefined;
  if (schema === undefined) {
    throw new Error(`${route.id} never answers ${canned.status}`);
  }
  if (schema) schema.parse(canned.body);
}
