import type { RouteId } from "./contract";
import { RentfreeError, RentfreeTimeout, RentfreeUnreachable } from "./errors";
import {
  createRequester,
  type CallOptions,
  type ClientOptions,
  type RouteInput,
  type RouteOutput,
} from "./request";

type Body<I extends RouteId> =
  RouteInput<I> extends { body?: infer B } ? B : never;
type Query<I extends RouteId> =
  RouteInput<I> extends { query?: infer Q } ? Q : never;

/** A page of a cursor-paginated list. */
interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every item of a paginated list, fetching pages as the loop asks for them. */
async function* everyItem<T>(
  page: (cursor: string | undefined) => Promise<PageOf<T>>,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const { items, nextCursor } = await page(cursor);
    yield* items;
    cursor = nextCursor ?? undefined;
  } while (cursor);
}

/** What `sources.addFile` takes: the bytes and what to call them. */
export interface FileToAdd {
  filename: string;
  contentType: Body<"createUpload">["contentType"];
  data: Blob | ArrayBuffer | Uint8Array;
  title?: string | null;
  collectionId?: string;
  /** Your own name for it; adding a file under the same name again updates that source. */
  externalId?: string;
  metadata?: Record<string, unknown>;
}

/** How long to wait for background work, and how often to look. */
export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface Client extends ReturnType<typeof createClient> {}

/**
 * A rentfree client. Every method is one route of the contract, typed by
 * its schemas, except the few that are more than one request: `addFile`,
 * `waitReady`, `waitForRecap`, and the `all` iterators.
 *
 * ```ts
 * const rf = createClient({ apiKey: process.env.RF_API_KEY });
 * const pack = await rf.context({ collectionId, query: "what did we decide?" });
 * ```
 */
export function createClient(
  options: ClientOptions & {
    /** How the waits pause; injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
) {
  const { request, call, baseUrl } = createRequester(options);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  /** Polls until `done` holds, or gives up. */
  async function waitFor<T>(
    what: string,
    poll: () => Promise<T>,
    done: (value: T) => boolean,
    { intervalMs = 1000, timeoutMs = 120_000 }: WaitOptions = {},
  ): Promise<T> {
    const started = now();
    for (;;) {
      const value = await poll();
      if (done(value)) return value;
      const waited = now() - started;
      if (waited >= timeoutMs) throw new RentfreeTimeout(what, waited);
      await sleep(Math.min(intervalMs, timeoutMs - waited));
    }
  }

  const id = (value: string) => ({ params: { id: value } });

  const sources = {
    add: (body: Body<"addSource">, opts?: CallOptions) =>
      call("addSource", { body, ...opts }),
    list: (query: Query<"listSources">) => call("listSources", { query }),
    all: (query: Omit<Query<"listSources">, "cursor">) =>
      everyItem((cursor) =>
        call("listSources", { query: { ...query, cursor } }),
      ),
    get: (sourceId: string) => call("getSource", id(sourceId)),
    content: async (sourceId: string) =>
      (await call("getSourceContent", id(sourceId))).content,
    chunks: (sourceId: string, query: Query<"listChunks"> = {}) =>
      call("listChunks", { ...id(sourceId), query }),
    allChunks: (
      sourceId: string,
      query: Omit<Query<"listChunks">, "cursor"> = {},
    ) =>
      everyItem((cursor) =>
        call("listChunks", { ...id(sourceId), query: { ...query, cursor } }),
      ),
    replace: (sourceId: string, body: Body<"replaceSource">) =>
      call("replaceSource", { ...id(sourceId), body }),
    refresh: (sourceId: string, opts?: CallOptions) =>
      call("refreshSource", { ...id(sourceId), ...opts }),
    remove: (sourceId: string) => call("removeSource", id(sourceId)),
    /** A short-lived URL to PUT a file to. `addFile` does all three steps. */
    upload: (body: Body<"createUpload">, opts?: CallOptions) =>
      call("createUpload", { body, ...opts }),

    /**
     * Adds a file: asks for an upload URL, sends the bytes there, then makes
     * the source. Ingest continues in the background; `waitReady` waits.
     */
    async addFile(file: FileToAdd, opts?: CallOptions) {
      const bytes =
        file.data instanceof Blob
          ? file.data
          : new Blob([file.data as BlobPart]);
      const upload = await sources.upload({
        filename: file.filename,
        contentType: file.contentType,
        size: bytes.size,
      });
      let sent: Response;
      try {
        // Straight to storage: no api key goes with the bytes.
        sent = await fetchImpl(upload.uploadUrl, {
          method: upload.method,
          headers: upload.headers,
          body: bytes,
        });
      } catch (cause) {
        throw new RentfreeUnreachable(upload.uploadUrl, cause);
      }
      if (!sent.ok) {
        throw new RentfreeError(sent.status, "upload_failed", [
          { path: "", message: `Storage answered HTTP ${sent.status}` },
        ]);
      }
      return sources.add(
        {
          kind: "file",
          blobKey: upload.blobKey,
          ...(file.title !== undefined ? { title: file.title } : {}),
          ...(file.collectionId ? { collectionId: file.collectionId } : {}),
          ...(file.externalId ? { externalId: file.externalId } : {}),
          ...(file.metadata ? { metadata: file.metadata } : {}),
        },
        opts,
      );
    },

    /** Waits until a source is `ready` or `failed`, and answers it either way. */
    waitReady: (sourceId: string, wait?: WaitOptions) =>
      waitFor(
        `source ${sourceId}`,
        () => sources.get(sourceId),
        (source) => source.status === "ready" || source.status === "failed",
        wait,
      ),
  };

  const sessions = {
    /**
     * Starts a session, or finds the one with this `externalId`: `created`
     * says which. The same id always finds the same session.
     */
    async start(body: Body<"startSession"> = {}, opts?: CallOptions) {
      const answer = await request("startSession", { body, ...opts });
      return { session: answer.data, created: answer.status === 201 };
    },
    list: (query: Query<"listSessions">) => call("listSessions", { query }),
    all: (query: Omit<Query<"listSessions">, "cursor">) =>
      everyItem((cursor) =>
        call("listSessions", { query: { ...query, cursor } }),
      ),
    get: (sessionId: string) => call("getSession", id(sessionId)),
    update: (sessionId: string, body: Body<"updateSession">) =>
      call("updateSession", { ...id(sessionId), body }),
    /** Ends a session, which starts a recap of anything not yet read. */
    end: (sessionId: string) =>
      call("updateSession", { ...id(sessionId), body: { ended: true } }),
    /** Logs one event or a batch of up to 100, all or none. */
    log: (sessionId: string, events: Body<"logEvents">, opts?: CallOptions) =>
      call("logEvents", { ...id(sessionId), body: events, ...opts }),
    events: (sessionId: string, query: Query<"listEvents"> = {}) =>
      call("listEvents", { ...id(sessionId), query }),
    allEvents: (sessionId: string) =>
      everyItem((cursor) =>
        call("listEvents", { ...id(sessionId), query: { cursor } }),
      ),
  };

  const memories = {
    create: (body: Body<"remember">, opts?: CallOptions) =>
      call("remember", { body, ...opts }),
    list: (query: Query<"listMemories">) => call("listMemories", { query }),
    all: (query: Omit<Query<"listMemories">, "cursor">) =>
      everyItem((cursor) =>
        call("listMemories", { query: { ...query, cursor } }),
      ),
    get: (memoryId: string) => call("getMemory", id(memoryId)),
    update: (memoryId: string, body: Body<"updateMemory">) =>
      call("updateMemory", { ...id(memoryId), body }),
    archive: (memoryId: string) => call("archiveMemory", id(memoryId)),
    restore: (memoryId: string) =>
      call("updateMemory", { ...id(memoryId), body: { status: "active" } }),
    history: (memoryId: string, query: Query<"memoryHistory"> = {}) =>
      call("memoryHistory", { ...id(memoryId), query }),
    sources: (memoryId: string) => call("memorySources", id(memoryId)),
  };

  const recap = {
    /** Starts a recap of the events not yet read: `started`, `running`, or `idle`. */
    run: (opts?: CallOptions) => call("runRecap", { ...opts }),
    runs: (query: Query<"listRecapRuns"> = {}) =>
      call("listRecapRuns", { query }),
    get: (runId: string) => call("getRecapRun", id(runId)),
    /**
     * Starts a recap if there is anything to read, then waits for the
     * newest run to finish. Answers null when there was nothing to read.
     */
    async runAndWait(wait?: WaitOptions) {
      // The run is made by a job a moment after the answer, so note the
      // newest run first and wait for a different one to finish.
      const previous = (await recap.runs({ limit: 1 })).runs[0]?.id ?? null;
      const asked = await recap.run();
      if (asked.status === "idle") return null;
      if (asked.status === "running") {
        const runId = asked.run.id;
        return waitFor(
          `recap run ${runId}`,
          () => recap.get(runId),
          (run) => run.finishedAt !== null,
          wait,
        );
      }
      const finished = await waitFor(
        "the recap run",
        async () => (await recap.runs({ limit: 1 })).runs[0] ?? null,
        (run) => run !== null && run.id !== previous && run.finishedAt !== null,
        wait,
      );
      return finished!;
    },
  };

  return {
    baseUrl,
    /** Any route by its contract id, for what the named methods do not cover. */
    call,
    /** Like `call`, with the status and headers. */
    request,

    health: () => call("health", {}),

    /** The login a CLI runs: start, poll, and the approval page's two calls. */
    login: {
      start: (body: Body<"startLogin">) => call("startLogin", { body }),
      poll: (deviceCode: string) => call("pollLogin", { body: { deviceCode } }),
      get: (userCode: string) => call("getLogin", { params: { userCode } }),
      answer: (body: Body<"answerLogin">) => call("answerLogin", { body }),
    },

    me: {
      get: () => call("getMe", {}),
      update: (body: Body<"updateMe">) => call("updateMe", { body }),
      delete: () => call("deleteMe", {}),
    },
    collections: {
      list: (query: Query<"listCollections"> = {}) =>
        call("listCollections", { query }),
      create: (body: Body<"createCollection">, opts?: CallOptions) =>
        call("createCollection", { body, ...opts }),
      update: (collectionId: string, body: Body<"updateCollection">) =>
        call("updateCollection", { ...id(collectionId), body }),
      archive: (collectionId: string) =>
        call("archiveCollection", id(collectionId)),
      profile: (collectionId: string) => call("getProfile", id(collectionId)),
    },
    agents: {
      list: (query: Query<"listAgents"> = {}) => call("listAgents", { query }),
      create: (body: Body<"createAgent">, opts?: CallOptions) =>
        call("createAgent", { body, ...opts }),
      update: (agentId: string, body: Body<"updateAgent">) =>
        call("updateAgent", { ...id(agentId), body }),
      revoke: (agentId: string) => call("revokeAgent", id(agentId)),
    },
    keys: {
      list: (query: Query<"listKeys"> = {}) => call("listKeys", { query }),
      create: (body: Body<"createKey">, opts?: CallOptions) =>
        call("createKey", { body, ...opts }),
      revoke: (keyId: string) => call("revokeKey", id(keyId)),
    },

    sessions,
    sources,
    memories,
    /** Writes a memory. The same as `memories.create`. */
    remember: memories.create,

    search: (body: Body<"search">) => call("search", { body }),
    /** A context pack: `text` goes straight into a prompt. */
    context: (body: Body<"context">) => call("context", { body }),
    recap,
    index: { status: () => call("indexStatus", {}) },
  };
}

export type { RouteInput, RouteOutput };
