import type { z } from "zod";
import type { Route, RouteId } from "./contract";
import { needsIdempotencyKey } from "./contract/idempotency";
import { ROUTE_TABLE } from "./route-table";
import { RentfreeUnreachable, errorFrom } from "./errors";

/** How a client reaches the api. */
export interface ClientOptions {
  /** An API key, `rf_…`. Without one only the login and health routes work. */
  apiKey?: string | null;
  /** The api, up to and including `/api`. */
  baseUrl?: string;
  /** Injectable, so tests, the CLI, and other runtimes bring their own. */
  fetch?: typeof globalThis.fetch;
  /** Sent on every request, such as a `User-Agent`. */
  headers?: Record<string, string>;
  /** Makes an Idempotency-Key for a write that was not given one. */
  idempotencyKey?: () => string;
}

export const DEFAULT_BASE_URL = "https://api.rentfree.dev/api";

type RouteOf<I extends RouteId> = Extract<Route, { id: I }>;
type InputOfSchema<S> = S extends z.ZodType ? z.input<S> : never;

/** A part of the request that may be left out when everything in it is optional. */
type Part<K extends string, S> = [S] extends [z.ZodType]
  ? object extends InputOfSchema<S>
    ? { [P in K]?: InputOfSchema<S> }
    : { [P in K]: InputOfSchema<S> }
  : unknown;

/** Options any call takes. */
export interface CallOptions {
  /** For a write: the key a retry repeats so the api replays the first answer. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** What a call to a route takes: its path parameters, query, and body, as the contract types them. */
export type RouteInput<I extends RouteId> = Part<
  "params",
  RouteOf<I> extends { params: infer P } ? P : undefined
> &
  Part<"query", RouteOf<I> extends { query: infer Q } ? Q : undefined> &
  Part<"body", RouteOf<I> extends { body: infer B } ? B : undefined> &
  CallOptions;

type ResponseSchemas<I extends RouteId> = Exclude<
  RouteOf<I>["responses"][keyof RouteOf<I>["responses"]],
  null
>;

/** What a call to a route answers: the union of its success bodies, or nothing for a 204. */
export type RouteOutput<I extends RouteId> = [ResponseSchemas<I>] extends [
  never,
]
  ? void
  : ResponseSchemas<I> extends z.ZodType
    ? z.output<ResponseSchemas<I>>
    : never;

/** An answer with its status, for the routes whose status says something. */
export interface Answer<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** What a request needs to know about a route. */
interface RoutePath {
  id: string;
  method: string;
  path: string;
}

const routeFor = (id: string): RoutePath | undefined => {
  const entry = (ROUTE_TABLE as Record<string, readonly [string, string]>)[id];
  return entry ? { id, method: entry[0], path: entry[1] } : undefined;
};

/** The URL for a route, with its path parameters filled in and its query appended. */
export function urlFor(
  baseUrl: string,
  spec: RoutePath,
  params: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): string {
  const path = spec.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === "") {
      throw new TypeError(`${spec.id}: missing path parameter ${name}`);
    }
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(name, String(item));
    } else {
      search.set(name, String(value));
    }
  }
  const qs = search.toString();
  return `${baseUrl.replace(/\/+$/, "")}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * Makes requests for any route in the contract. Every call is one request:
 * the key as a bearer, an Idempotency-Key on a write, JSON in and out.
 * Answers are not checked against the contract at run time, so a newer api
 * that adds a field does not break an older client.
 */
export function createRequester(options: ClientOptions = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const newKey = options.idempotencyKey ?? (() => crypto.randomUUID());

  async function request<I extends RouteId>(
    id: I,
    input: RouteInput<I>,
  ): Promise<Answer<RouteOutput<I>>> {
    const spec = routeFor(id);
    if (!spec) throw new TypeError(`No route ${id}`);
    const { params, query, body, idempotencyKey, signal } = input as {
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
    } & CallOptions;

    const url = urlFor(baseUrl, spec, params, query);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
    };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (needsIdempotencyKey(spec)) {
      headers["idempotency-key"] = idempotencyKey ?? newKey();
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: spec.method.toUpperCase(),
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw new RentfreeUnreachable(url, cause);
    }

    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) throw errorFrom(response.status, json, spec.id);
    return {
      data: (response.status === 204 ? undefined : json) as RouteOutput<I>,
      status: response.status,
      headers: response.headers,
    };
  }

  /** Calls a route and answers its body. */
  const call = async <I extends RouteId>(id: I, input: RouteInput<I>) =>
    (await request(id, input)).data;

  return { request, call, baseUrl };
}

export type Requester = ReturnType<typeof createRequester>;
