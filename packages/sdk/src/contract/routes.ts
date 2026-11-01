import { z } from "zod";
import * as accounts from "./accounts";
import { idParams } from "./common";
import { needsIdempotencyKey } from "./idempotency";
import * as device from "./device";
import * as memories from "./memories";
import * as recall from "./recall";
import * as recap from "./recap";
import * as sessions from "./sessions";
import * as sources from "./sources";

/** Every `error` the api answers with, and its status. */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  access_denied: 403,
  not_found: 404,
  collection_archived: 409,
  collection_default: 409,
  name_taken: 409,
  embed_model_in_use: 409,
  session_ended: 409,
  source_not_ready: 409,
  not_a_text_source: 409,
  not_refreshable: 409,
  ingest_in_progress: 409,
  source_kind_mismatch: 409,
  memory_inactive: 409,
  memory_expired: 409,
  idempotency_key_in_progress: 409,
  device_session_expired: 410,
  idempotency_key_reused: 422,
  rate_limited: 429,
  slow_down: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * Who may call a route. `apiKey`: any key. `userKey`: a user-level key; an
 * agent key gets 403. `session`: a signed-in browser's Clerk token, for the
 * approval page. `none`: anyone, such as a CLI that has no key yet.
 */
export type Auth = "apiKey" | "userKey" | "session" | "none";

export type Method = "get" | "post" | "put" | "patch" | "delete";

export interface RouteSpec {
  /** Unique, and the name an SDK method or a doc anchor uses. */
  readonly id: string;
  readonly method: Method;
  /** Under `/api`, with `{name}` for a path parameter. */
  readonly path: string;
  readonly auth: Auth;
  readonly tag: string;
  readonly summary: string;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** Each success status and its body; null for none. */
  readonly responses: Readonly<Record<number, z.ZodType | null>>;
  /**
   * The errors particular to this route. Those every route of its kind can
   * answer are added by `errorsOf`: `unauthorized` for a key or a session,
   * `forbidden` for a user-level key, `invalid_request` for a body or a
   * query, and the idempotency errors for a write.
   */
  readonly errors: readonly ErrorCode[];
}

const route = <const R extends RouteSpec>(spec: R): R => spec;

export { READ_ONLY_POSTS, needsIdempotencyKey } from "./idempotency";

/** Every error a route can answer, its own and those of its kind, in status order. */
export function errorsOf(spec: RouteSpec): ErrorCode[] {
  const codes = new Set<ErrorCode>(spec.errors);
  if (spec.body || spec.query || spec.params) codes.add("invalid_request");
  if (spec.auth !== "none") codes.add("unauthorized");
  if (spec.auth === "userKey") codes.add("forbidden");
  if (needsIdempotencyKey(spec)) {
    codes.add("invalid_request");
    codes.add("idempotency_key_in_progress");
    codes.add("idempotency_key_reused");
  }
  codes.add("internal");
  return [...codes].sort(
    (a, b) => ERROR_STATUS[a] - ERROR_STATUS[b] || a.localeCompare(b),
  );
}

/** The refusals any route about one collection's contents can answer. */
const scoped = ["forbidden", "not_found"] as const;
const scopedWrite = [...scoped, "collection_archived"] as const;

const collectionParams = z.object({ id: z.string().min(1) });

export const ROUTES = [
  // Unversioned.
  route({
    id: "health",
    method: "get",
    path: "/health",
    auth: "none",
    tag: "meta",
    summary: "Whether the api and its database are up",
    responses: { 200: device.health, 503: device.health },
    errors: [],
  }),
  route({
    id: "openapi",
    method: "get",
    path: "/openapi.json",
    auth: "none",
    tag: "meta",
    summary: "This document",
    responses: { 200: device.openApiDocument },
    errors: [],
  }),

  // A login in progress, from the CLI's first request to its key.
  route({
    id: "startLogin",
    method: "post",
    path: "/auth/device",
    auth: "none",
    tag: "login",
    summary: "Start a login; the CLI shows the code and opens the page",
    body: device.startLoginBody,
    responses: { 201: device.loginStarted },
    errors: ["rate_limited"],
  }),
  route({
    id: "pollLogin",
    method: "post",
    path: "/auth/device/poll",
    auth: "none",
    tag: "login",
    summary: "Ask whether the browser has approved; the key comes back once",
    body: device.pollLoginBody,
    responses: { 200: device.loginPoll },
    errors: [
      "access_denied",
      "not_found",
      "device_session_expired",
      "slow_down",
    ],
  }),
  route({
    id: "getLogin",
    method: "get",
    path: "/auth/device/{userCode}",
    auth: "session",
    tag: "login",
    summary: "What the approval page shows about a login",
    params: device.userCodeParams,
    responses: { 200: device.deviceSession },
    errors: ["not_found"],
  }),
  route({
    id: "answerLogin",
    method: "post",
    path: "/auth/device/approve",
    auth: "session",
    tag: "login",
    summary: "Approve or deny a login; a first approval creates the account",
    body: device.approveLoginBody,
    responses: { 200: device.loginAnswered },
    errors: ["forbidden", "not_found"],
  }),

  // The account.
  route({
    id: "getMe",
    method: "get",
    path: "/v1/me",
    auth: "apiKey",
    tag: "account",
    summary: "The user, the key in use, and what it can see",
    responses: { 200: accounts.me },
    errors: ["not_found"],
  }),
  route({
    id: "updateMe",
    method: "patch",
    path: "/v1/me",
    auth: "userKey",
    tag: "account",
    summary: "Choose the embedding model, while the account has no content",
    body: accounts.patchMeBody,
    responses: { 200: accounts.user },
    errors: ["not_found", "embed_model_in_use"],
  }),
  route({
    id: "deleteMe",
    method: "delete",
    path: "/v1/me",
    auth: "userKey",
    tag: "account",
    summary: "Delete the account; every key stops at once",
    responses: { 200: accounts.deletedUser },
    errors: ["not_found"],
  }),
  route({
    id: "listCollections",
    method: "get",
    path: "/v1/collections",
    auth: "apiKey",
    tag: "account",
    summary: "Collections; an agent sees the active ones it may read",
    query: accounts.archivableQuery,
    responses: { 200: accounts.collectionList },
    errors: ["forbidden"],
  }),
  route({
    id: "createCollection",
    method: "post",
    path: "/v1/collections",
    auth: "userKey",
    tag: "account",
    summary: "Make a collection",
    body: accounts.createCollectionBody,
    responses: { 201: accounts.collection },
    errors: ["name_taken"],
  }),
  route({
    id: "updateCollection",
    method: "patch",
    path: "/v1/collections/{id}",
    auth: "userKey",
    tag: "account",
    summary: "Rename a collection, or make it the default",
    params: idParams,
    body: accounts.patchCollectionBody,
    responses: { 200: accounts.collection },
    errors: ["not_found", "collection_archived", "name_taken"],
  }),
  route({
    id: "archiveCollection",
    method: "delete",
    path: "/v1/collections/{id}",
    auth: "userKey",
    tag: "account",
    summary: "Archive a collection: still readable, nothing new goes in",
    params: idParams,
    responses: { 200: accounts.collection },
    errors: ["not_found", "collection_default"],
  }),
  route({
    id: "listAgents",
    method: "get",
    path: "/v1/agents",
    auth: "userKey",
    tag: "account",
    summary: "Agents, live by default",
    query: accounts.revocableQuery,
    responses: { 200: accounts.agentList },
    errors: [],
  }),
  route({
    id: "createAgent",
    method: "post",
    path: "/v1/agents",
    auth: "userKey",
    tag: "account",
    summary: "Make an agent with its permissions",
    body: accounts.createAgentBody,
    responses: { 201: accounts.agent },
    errors: [],
  }),
  route({
    id: "updateAgent",
    method: "patch",
    path: "/v1/agents/{id}",
    auth: "userKey",
    tag: "account",
    summary: "Change an agent's name or permissions",
    params: idParams,
    body: accounts.patchAgentBody,
    responses: { 200: accounts.agent },
    errors: ["not_found"],
  }),
  route({
    id: "revokeAgent",
    method: "delete",
    path: "/v1/agents/{id}",
    auth: "userKey",
    tag: "account",
    summary: "Revoke an agent and every key it holds",
    params: idParams,
    responses: { 200: accounts.revokedAgent },
    errors: ["not_found"],
  }),
  route({
    id: "listKeys",
    method: "get",
    path: "/v1/keys",
    auth: "userKey",
    tag: "account",
    summary: "Keys, live by default; never the secret",
    query: accounts.revocableQuery,
    responses: { 200: accounts.keyList },
    errors: [],
  }),
  route({
    id: "createKey",
    method: "post",
    path: "/v1/keys",
    auth: "userKey",
    tag: "account",
    summary: "Mint a key; the secret is in this answer only",
    body: accounts.createKeyBody,
    responses: { 201: accounts.createdKey },
    errors: [],
  }),
  route({
    id: "revokeKey",
    method: "delete",
    path: "/v1/keys/{id}",
    auth: "userKey",
    tag: "account",
    summary: "Revoke a key",
    params: idParams,
    responses: { 200: accounts.key },
    errors: ["not_found"],
  }),

  // Sessions and events.
  route({
    id: "startSession",
    method: "post",
    path: "/v1/sessions",
    auth: "apiKey",
    tag: "sessions",
    summary: "Start a session, or find the one with this externalId",
    body: sessions.createSessionBody,
    responses: { 201: sessions.session, 200: sessions.session },
    errors: [...scopedWrite],
  }),
  route({
    id: "listSessions",
    method: "get",
    path: "/v1/sessions",
    auth: "apiKey",
    tag: "sessions",
    summary: "Sessions in a collection, newest first",
    query: sessions.listSessionsQuery,
    responses: { 200: sessions.sessionPage },
    errors: [...scoped],
  }),
  route({
    id: "getSession",
    method: "get",
    path: "/v1/sessions/{id}",
    auth: "apiKey",
    tag: "sessions",
    summary: "One session",
    params: idParams,
    responses: { 200: sessions.session },
    errors: [...scoped],
  }),
  route({
    id: "updateSession",
    method: "patch",
    path: "/v1/sessions/{id}",
    auth: "apiKey",
    tag: "sessions",
    summary: "Retitle a session, or end it, which starts a recap",
    params: idParams,
    body: sessions.updateSessionBody,
    responses: { 200: sessions.session },
    errors: [...scopedWrite],
  }),
  route({
    id: "logEvents",
    method: "post",
    path: "/v1/sessions/{id}/events",
    auth: "apiKey",
    tag: "sessions",
    summary: "Log one event, or a batch of up to 100, all or none",
    params: idParams,
    body: sessions.appendEventsBody,
    responses: { 201: sessions.appendedEvents },
    errors: [...scopedWrite, "session_ended"],
  }),
  route({
    id: "listEvents",
    method: "get",
    path: "/v1/sessions/{id}/events",
    auth: "apiKey",
    tag: "sessions",
    summary: "A session's events, oldest first",
    params: idParams,
    query: sessions.listEventsQuery,
    responses: { 200: sessions.eventPage },
    errors: [...scoped],
  }),

  // Sources and uploads.
  route({
    id: "addSource",
    method: "post",
    path: "/v1/sources",
    auth: "apiKey",
    tag: "sources",
    summary:
      "Add text, a URL, or an uploaded file; under an external id the collection already has, update that source",
    body: sources.createSourceBody,
    responses: {
      201: sources.addedSource,
      202: sources.source,
      200: sources.source,
    },
    errors: [...scopedWrite, "ingest_in_progress", "source_kind_mismatch"],
  }),
  route({
    id: "listSources",
    method: "get",
    path: "/v1/sources",
    auth: "apiKey",
    tag: "sources",
    summary: "Sources in a collection, newest first",
    query: sources.listSourcesQuery,
    responses: { 200: sources.sourcePage },
    errors: [...scoped],
  }),
  route({
    id: "getSource",
    method: "get",
    path: "/v1/sources/{id}",
    auth: "apiKey",
    tag: "sources",
    summary: "One source, with its ingest status",
    params: idParams,
    responses: { 200: sources.source },
    errors: [...scoped],
  }),
  route({
    id: "getSourceContent",
    method: "get",
    path: "/v1/sources/{id}/content",
    auth: "apiKey",
    tag: "sources",
    summary: "A ready source's text",
    params: idParams,
    responses: { 200: sources.sourceContent },
    errors: [...scoped, "source_not_ready"],
  }),
  route({
    id: "listChunks",
    method: "get",
    path: "/v1/sources/{id}/chunks",
    auth: "apiKey",
    tag: "sources",
    summary: "A source's chunks, in document order",
    params: idParams,
    query: sources.listChunksQuery,
    responses: { 200: sources.chunkPage },
    errors: [...scoped],
  }),
  route({
    id: "replaceSource",
    method: "put",
    path: "/v1/sources/{id}",
    auth: "apiKey",
    tag: "sources",
    summary: "Replace a text source; unchanged content is a no-op",
    params: idParams,
    body: sources.replaceSourceBody,
    responses: { 200: sources.source },
    errors: [...scopedWrite, "not_a_text_source"],
  }),
  route({
    id: "refreshSource",
    method: "post",
    path: "/v1/sources/{id}/refresh",
    auth: "apiKey",
    tag: "sources",
    summary: "Fetch a URL source again",
    params: idParams,
    responses: { 202: sources.source },
    errors: [...scopedWrite, "not_refreshable", "ingest_in_progress"],
  }),
  route({
    id: "removeSource",
    method: "delete",
    path: "/v1/sources/{id}",
    auth: "apiKey",
    tag: "sources",
    summary: "Remove a source and its chunks",
    params: idParams,
    responses: { 204: null },
    errors: [...scopedWrite],
  }),
  route({
    id: "createUpload",
    method: "post",
    path: "/v1/uploads",
    auth: "apiKey",
    tag: "sources",
    summary: "Get a short-lived URL to PUT a file to, before adding it",
    body: sources.createUploadBody,
    responses: { 201: sources.upload },
    errors: [],
  }),

  // Memories.
  route({
    id: "remember",
    method: "post",
    path: "/v1/memories",
    auth: "apiKey",
    tag: "memories",
    summary: "Write a memory",
    body: memories.createMemoryBody,
    responses: { 201: memories.memory },
    errors: [...scopedWrite],
  }),
  route({
    id: "listMemories",
    method: "get",
    path: "/v1/memories",
    auth: "apiKey",
    tag: "memories",
    summary: "Memories in a collection, newest first",
    query: memories.listMemoriesQuery,
    responses: { 200: memories.memoryPage },
    errors: [...scoped],
  }),
  route({
    id: "getMemory",
    method: "get",
    path: "/v1/memories/{id}",
    auth: "apiKey",
    tag: "memories",
    summary: "One memory",
    params: idParams,
    responses: { 200: memories.memory },
    errors: [...scoped],
  }),
  route({
    id: "updateMemory",
    method: "patch",
    path: "/v1/memories/{id}",
    auth: "apiKey",
    tag: "memories",
    summary: "Correct a memory, or archive or restore it",
    params: idParams,
    body: memories.patchMemoryBody,
    responses: { 200: memories.memory },
    errors: [...scopedWrite, "memory_inactive", "memory_expired"],
  }),
  route({
    id: "archiveMemory",
    method: "delete",
    path: "/v1/memories/{id}",
    auth: "apiKey",
    tag: "memories",
    summary: "Archive a memory; its history and sources stay",
    params: idParams,
    responses: { 200: memories.memory },
    errors: [...scopedWrite],
  }),
  route({
    id: "memoryHistory",
    method: "get",
    path: "/v1/memories/{id}/history",
    auth: "apiKey",
    tag: "memories",
    summary: "Every change to a memory, newest first",
    params: idParams,
    query: memories.historyQuery,
    responses: { 200: memories.memoryHistory },
    errors: [...scoped],
  }),
  route({
    id: "memorySources",
    method: "get",
    path: "/v1/memories/{id}/sources",
    auth: "apiKey",
    tag: "memories",
    summary: "Where a memory came from",
    params: idParams,
    responses: { 200: memories.memorySources },
    errors: [...scoped],
  }),

  // Recall.
  route({
    id: "search",
    method: "post",
    path: "/v1/search",
    auth: "apiKey",
    tag: "recall",
    summary: "Find memories and passages by meaning and by words",
    body: recall.searchBody,
    responses: { 200: recall.searchResult },
    errors: [...scoped, "collection_archived"],
  }),
  route({
    id: "context",
    method: "post",
    path: "/v1/context",
    auth: "apiKey",
    tag: "recall",
    summary:
      "A context pack: what an agent needs for its next turn, within a budget",
    body: recall.contextBody,
    responses: { 200: recall.contextPack },
    errors: [...scoped, "collection_archived"],
  }),
  route({
    id: "getProfile",
    method: "get",
    path: "/v1/collections/{id}/profile",
    auth: "apiKey",
    tag: "recall",
    summary: "A collection's latest profile",
    params: collectionParams,
    responses: { 200: recall.profile },
    errors: [...scoped, "collection_archived"],
  }),

  // Recap and the index.
  route({
    id: "runRecap",
    method: "post",
    path: "/v1/recap/run",
    auth: "apiKey",
    tag: "recap",
    summary: "Start a recap of the events not yet read",
    responses: { 200: recap.recapRunStarted, 202: recap.recapRunStarted },
    errors: ["forbidden"],
  }),
  route({
    id: "listRecapRuns",
    method: "get",
    path: "/v1/recap/runs",
    auth: "apiKey",
    tag: "recap",
    summary: "Recap runs, newest first",
    query: recap.listRecapRunsQuery,
    responses: { 200: recap.recapRuns },
    errors: ["forbidden"],
  }),
  route({
    id: "getRecapRun",
    method: "get",
    path: "/v1/recap/runs/{id}",
    auth: "apiKey",
    tag: "recap",
    summary: "One recap run",
    params: idParams,
    responses: { 200: recap.recapRun },
    errors: ["forbidden", "not_found"],
  }),
  route({
    id: "indexStatus",
    method: "get",
    path: "/v1/index/status",
    auth: "apiKey",
    tag: "recall",
    summary: "How much content is still waiting to be embedded",
    responses: { 200: recap.indexStatus },
    errors: [],
  }),
] as const;

export type Route = (typeof ROUTES)[number];
export type RouteId = Route["id"];

/** The route with this id. */
export function routeById<I extends RouteId>(id: I): Extract<Route, { id: I }> {
  const found = ROUTES.find((r) => r.id === id);
  if (!found) throw new Error(`no route ${id}`);
  return found as Extract<Route, { id: I }>;
}

/**
 * The route a request was answered by, from its method and its path under
 * `/api`, or undefined. Literal segments win over parameters, the way Hono
 * matches `/sources/{id}/content` before `/sources/{id}`.
 */
export function matchRoute(method: string, path: string): Route | undefined {
  const want = path.split("?")[0]!.replace(/\/+$/, "").split("/");
  const m = method.toLowerCase();
  const candidates = ROUTES.filter((r) => {
    if (r.method !== m) return false;
    const have = r.path.split("/");
    return (
      have.length === want.length &&
      have.every((seg, i) => seg.startsWith("{") || seg === want[i])
    );
  });
  const literals = (r: Route) =>
    r.path.split("/").filter((seg) => !seg.startsWith("{")).length;
  return candidates.sort((a, b) => literals(b) - literals(a))[0];
}
