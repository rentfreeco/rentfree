# @rentfree/sdk

The TypeScript client for [rentfree](https://rentfree.dev), memory for AI agents, and the contract it is typed by. An agent logs what it sees and what you give it; rentfree turns that into searchable, attributable memories and hands back the right context for its next turn, within a token budget.

> **Typed by the api's own contract.** The api validates every request with the same zod schemas this package's types come from, so a required field is required here too, and a closed vocabulary is closed. One method per endpoint, plus the few helpers that take more than one request.

## Prerequisites

- Node.js **20** or later, or any runtime with `fetch`: Bun, Deno, and edge runtimes
- An API key, `rf_…`. `rf init` from [`@rentfree/cli`](https://www.npmjs.com/package/@rentfree/cli) signs you in (a first sign-in is a sign-up), and `rf keys create` mints more

## Installation

```sh
npm install @rentfree/sdk
```

It is ESM only, and depends on nothing but `zod` 4.

## Quick start

```ts
import { createClient } from "@rentfree/sdk";

const rf = createClient({ apiKey: process.env.RF_API_KEY });

// Which collections the key can see; one of them is the default
const { collections } = await rf.me.get();
const collectionId = collections.find((c) => c.isDefault)!.id;

// The one call an agent makes per turn: text for its prompt, within a budget
const pack = await rf.context({
  collectionId,
  query: "how do we deploy?",
  tokenBudget: 1500,
});
console.log(pack.text);

// Log a conversation; the same externalId always finds the same session
const { session } = await rf.sessions.start({ externalId: "my-agent:run-42" });
await rf.sessions.log(session.id, {
  events: [
    { type: "message.user", content: "How do we deploy?" },
    { type: "message.assistant", content: "From main, once CI is green." },
  ],
});
await rf.sessions.end(session.id); // starts a recap into memories

// Write a memory yourself
await rf.remember({
  collectionId,
  type: "decision",
  tier: "long",
  content: "Deploys need green CI.",
});

// Find memories and document passages
const found = await rf.search({ query: "deploy" });
```

## How it fits together

Everything lives in a **collection**. An agent logs a **session** as it happens, one event at a time. Ending the session starts a **recap**, which turns its events into **memories** and rewrites the collection's **profile**, a standing summary. You can also write memories yourself, and add **sources**: text, URLs, and files, split into passages. `context` and `search` read all of it back.

A key is **user-level**, or belongs to an **agent**: an identity with its own permissions, such as read-only or a few collections. An agent's key can do what its agent may, and nothing that manages the account.

## Client options

```ts
const rf = createClient({
  apiKey: process.env.RF_API_KEY,
  headers: { "user-agent": "my-agent/1.0" },
});
```

| Option           | Description                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `apiKey`         | An API key, `rf_…`, sent as a bearer. Without one, only the login and health routes work       |
| `baseUrl`        | The api, up to and including `/api`. `https://api.rentfree.dev/api` by default                 |
| `fetch`          | The `fetch` to use; `globalThis.fetch` by default                                              |
| `headers`        | Sent on every request, such as a `User-Agent`                                                  |
| `idempotencyKey` | Makes the `Idempotency-Key` for a write that was not given one; `crypto.randomUUID` by default |

## Methods

Each method is one request to one route, typed by that route's schemas, except where a row says otherwise. The route ids are the ones `call` and the [contract](#the-contract-and-openapi) use. A method marked _user key_ refuses an agent's key with `forbidden`.

### Recall

| Method                    | Route                                           | Does                                                                                        |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `context(body)`           | `context` `POST /v1/context`                    | A context pack: `text` for a prompt, and the profile, memories, and chunks it was made from |
| `search(body)`            | `search` `POST /v1/search`                      | Memories and document passages, by meaning and by words, each with a `score`                |
| `collections.profile(id)` | `getProfile` `GET /v1/collections/{id}/profile` | A collection's profile, as recap last wrote it                                              |

`context` takes a `collectionId`, an optional `query` (without one, the pack is the profile and the most important memories), and a `tokenBudget` from 200 to 16000, 2000 by default. `search` takes a `query` and, optionally, `collectionIds` (otherwise every one the key may read), `kinds` (`memory`, `chunk`), `types`, `tiers`, `asOf`, and a `limit` of each kind, 1 to 50, 10 by default.

### Memories

| Method                         | Route                                           | Does                                                                           |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `remember(body)`               | `remember` `POST /v1/memories`                  | Write a memory. The same as `memories.create`                                  |
| `memories.list(query)`         | `listMemories` `GET /v1/memories`               | A page of a collection's memories, newest first                                |
| `memories.all(query)`          | `listMemories`                                  | Every memory, page by page, as an async iterator                               |
| `memories.get(id)`             | `getMemory` `GET /v1/memories/{id}`             | One memory                                                                     |
| `memories.update(id, body)`    | `updateMemory` `PATCH /v1/memories/{id}`        | Correct its `content`, `subject`, or `importance`; a new text is a new version |
| `memories.archive(id)`         | `archiveMemory` `DELETE /v1/memories/{id}`      | Retire it; its history and sources stay                                        |
| `memories.restore(id)`         | `updateMemory`                                  | Bring an archived memory back                                                  |
| `memories.history(id, query?)` | `memoryHistory` `GET /v1/memories/{id}/history` | Every change to it, newest first, and who made it                              |
| `memories.sources(id)`         | `memorySources` `GET /v1/memories/{id}/sources` | Where it came from: a passage, a session's event, or both                      |

A memory has a `type` (`fact`, `preference`, `decision`, `plan`, or your own) and a `tier`: `long` lasts and fades slowly; `working` expires, in a day unless `expiresAt` says otherwise, within thirty days.

### Sessions

| Method                        | Route                                       | Does                                                                          |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `sessions.start(body?)`       | `startSession` `POST /v1/sessions`          | Start a session, or find the one with this `externalId`; `created` says which |
| `sessions.log(id, events)`    | `logEvents` `POST /v1/sessions/{id}/events` | Log one event, or `{ events }`: up to 100, all or none                        |
| `sessions.end(id)`            | `updateSession` `PATCH /v1/sessions/{id}`   | End it, which starts a recap of anything not yet read                         |
| `sessions.update(id, body)`   | `updateSession`                             | Change its `title`                                                            |
| `sessions.list(query)`        | `listSessions` `GET /v1/sessions`           | A page of a collection's sessions, newest first                               |
| `sessions.all(query)`         | `listSessions`                              | Every session, as an async iterator                                           |
| `sessions.get(id)`            | `getSession` `GET /v1/sessions/{id}`        | One session                                                                   |
| `sessions.events(id, query?)` | `listEvents` `GET /v1/sessions/{id}/events` | A page of its events, oldest first                                            |
| `sessions.allEvents(id)`      | `listEvents`                                | Every event, as an async iterator                                             |

An event's `type` is one of `message.user`, `message.assistant`, `tool.call`, `tool.result`, and `note`, with up to 100,000 characters of `content` and 16 KB of `metadata`.

### Sources

| Method                          | Route                                             | Does                                                                             |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `sources.add(body)`             | `addSource` `POST /v1/sources`                    | Add `text` or a `url`; adding one under the same `externalId` again updates it   |
| `sources.addFile(file)`         | `createUpload`, then `addSource`                  | Upload a PDF, Markdown, or plain-text file, up to 20 MB, and make a source of it |
| `sources.waitReady(id, wait?)`  | `getSource`, polled                               | Wait until it is `ready` or `failed`, and answer it either way                   |
| `sources.list(query)`           | `listSources` `GET /v1/sources`                   | A page of a collection's sources, newest first                                   |
| `sources.all(query)`            | `listSources`                                     | Every source, as an async iterator                                               |
| `sources.get(id)`               | `getSource` `GET /v1/sources/{id}`                | One source, with its ingest `status`                                             |
| `sources.content(id)`           | `getSourceContent` `GET /v1/sources/{id}/content` | A ready source's text, as a string                                               |
| `sources.chunks(id, query?)`    | `listChunks` `GET /v1/sources/{id}/chunks`        | A page of its passages, by `level`: `document`, `section`, or `paragraph`        |
| `sources.allChunks(id, query?)` | `listChunks`                                      | Every passage, as an async iterator                                              |
| `sources.replace(id, body)`     | `replaceSource` `PUT /v1/sources/{id}`            | New text for a text source                                                       |
| `sources.refresh(id)`           | `refreshSource` `POST /v1/sources/{id}/refresh`   | Fetch a URL source again                                                         |
| `sources.remove(id)`            | `removeSource` `DELETE /v1/sources/{id}`          | Remove it and its passages                                                       |
| `sources.upload(body)`          | `createUpload` `POST /v1/uploads`                 | A short-lived URL to `PUT` a file to; `addFile` does this for you                |

```ts
import { readFile } from "node:fs/promises";

const added = await rf.sources.addFile({
  filename: "runbook.md",
  contentType: "text/markdown",
  data: await readFile("./docs/runbook.md"),
  externalId: "file:docs/runbook.md",
});
const source = await rf.sources.waitReady(added.id);
if (source.status === "failed")
  throw new Error(source.error ?? "ingest failed");
```

A text source is ready at once, and holds up to 1 MB. A URL or a file is fetched or read in the background; the file's bytes go straight to storage, without the API key.

### Recap

| Method                    | Route                                    | Does                                                                                      |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `recap.run()`             | `runRecap` `POST /v1/recap/run`          | Recap the events not yet read. `status` is `started`, `running` (one is going), or `idle` |
| `recap.runAndWait(wait?)` | `runRecap`, then `listRecapRuns`, polled | Start a recap and wait for it to finish; null when there was nothing to read              |
| `recap.runs(query?)`      | `listRecapRuns` `GET /v1/recap/runs`     | Recap runs, newest first                                                                  |
| `recap.get(id)`           | `getRecapRun` `GET /v1/recap/runs/{id}`  | One run: the events it read, what it did (`stats`), and what it cost                      |
| `index.status()`          | `indexStatus` `GET /v1/index/status`     | How much is still waiting to be embedded                                                  |

### The account

| Method                         | Route                                             | Does                                                                           |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `me.get()`                     | `getMe` `GET /v1/me`                              | The user, the key in use, and the collections it can see                       |
| `me.update(body)`              | `updateMe` `PATCH /v1/me`                         | _User key._ Choose the embedding model, while the account has no content yet   |
| `me.delete()`                  | `deleteMe` `DELETE /v1/me`                        | _User key._ Delete the account and everything in it                            |
| `collections.list(query?)`     | `listCollections` `GET /v1/collections`           | Active collections, or `{ status: "archived" }`                                |
| `collections.create(body)`     | `createCollection` `POST /v1/collections`         | _User key._ A new collection, by `name`                                        |
| `collections.update(id, body)` | `updateCollection` `PATCH /v1/collections/{id}`   | _User key._ Rename it, or make it the default with `isDefault: true`           |
| `collections.archive(id)`      | `archiveCollection` `DELETE /v1/collections/{id}` | _User key._ Archive it; it stays readable                                      |
| `agents.list(query?)`          | `listAgents` `GET /v1/agents`                     | _User key._ Live agents, or `{ status: "revoked" }`                            |
| `agents.create(body)`          | `createAgent` `POST /v1/agents`                   | _User key._ An agent, with its permissions                                     |
| `agents.update(id, body)`      | `updateAgent` `PATCH /v1/agents/{id}`             | _User key._ Change its name or permissions                                     |
| `agents.revoke(id)`            | `revokeAgent` `DELETE /v1/agents/{id}`            | _User key._ Revoke it and every key it holds                                   |
| `keys.list(query?)`            | `listKeys` `GET /v1/keys`                         | _User key._ Live keys, or `{ status: "revoked" }`                              |
| `keys.create(body)`            | `createKey` `POST /v1/keys`                       | _User key._ Mint a key, user-level or for an `agentId`; `apiKey` is shown once |
| `keys.revoke(id)`              | `revokeKey` `DELETE /v1/keys/{id}`                | _User key._ Revoke a key                                                       |

```ts
const agent = await rf.agents.create({
  name: "reviewer",
  canReadMemories: true,
  canWriteMemories: false,
  readCollectionIds: [collectionId],
  writeCollectionIds: [],
});
const { apiKey } = await rf.keys.create({
  name: "reviewer",
  agentId: agent.id,
});
const reviewer = createClient({ apiKey });
```

### Signing in, and the rest

| Method                                        | Route                     | Does                                                                                                     |
| --------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `login.start(body)`, `login.poll(deviceCode)` | `startLogin`, `pollLogin` | The device flow `rf init` runs: get a code, send the person to approve it, poll for a key. No key needed |
| `login.get(userCode)`, `login.answer(body)`   | `getLogin`, `answerLogin` | The approval page's two calls; they take a signed-in browser session, not an API key                     |
| `health()`                                    | `health` `GET /health`    | Whether the api is up. No key needed                                                                     |
| `call(id, input)`                             | any                       | Any route by its id: `{ params, query, body }` as the contract types them                                |
| `request(id, input)`                          | any                       | Like `call`, with the answer's `status` and `headers` too                                                |

```ts
// The OpenAPI document the api serves, which has no method of its own
const document = await rf.call("openapi", {});

// The same request as rf.memories.get, by route id
const memory = await rf.call("getMemory", { params: { id: memoryId } });
```

## Pagination

The lists of memories, sources, sessions, events, and passages are pages: `{ items, nextCursor }`, with `nextCursor` null on the last one. Pass it back as `cursor` for the next page, or let an `all` method follow the cursors for you:

```ts
for await (const memory of rf.memories.all({
  collectionId,
  status: "active",
})) {
  console.log(memory.id, memory.content);
}
```

Collections, agents, and keys come back whole, as `{ collections }`, `{ agents }`, and `{ keys }`.

## Waiting for background work

Ingesting a URL or a file, and recapping, happen after the request has answered. `sources.waitReady` and `recap.runAndWait` poll until the work is done: every second, for up to two minutes, unless you say otherwise. A wait that gives up throws `RentfreeTimeout`.

```ts
const run = await rf.recap.runAndWait({ intervalMs: 2000, timeoutMs: 300_000 });
if (run) console.log(run.stats);
```

## Errors

| Class                 | When                                                             | What it holds                                                   |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `RentfreeError`       | The api answered with an error                                   | `status`, `code` such as `not_found`, `issues`, and the `route` |
| `RentfreeUnreachable` | The request got no answer: the network failed, or it was aborted | `url`, and the `cause`                                          |
| `RentfreeTimeout`     | A wait gave up before the work finished                          | `what` it waited for, and `waitedMs`                            |

```ts
import { RentfreeError, RentfreeUnreachable } from "@rentfree/sdk";

try {
  await rf.memories.update(memoryId, {
    content: "Deploys need green CI and a review.",
  });
} catch (error) {
  if (error instanceof RentfreeError && error.code === "memory_expired") {
    // write a new one instead
  } else if (error instanceof RentfreeUnreachable) {
    // try again later
  } else {
    throw error;
  }
}
```

`issues` says what was wrong with a request, field by field, as `{ path, message }`. Every `code` and its HTTP status is in `ERROR_STATUS`, and the contract lists the codes each route can answer: `errorsOf(routeById("updateMemory"))`.

## Retries and idempotency

Every `POST` under `/v1` that writes carries an `Idempotency-Key`, a new one for each call unless you pass your own. To retry a write safely, pass the same key again: the api replays the first answer instead of writing twice.

```ts
const idempotencyKey = crypto.randomUUID();
const write = () =>
  rf.remember(
    {
      collectionId,
      type: "fact",
      tier: "long",
      content: "Deploys need green CI.",
    },
    { idempotencyKey },
  );
const memory = await write().catch((error) => {
  if (error instanceof RentfreeUnreachable) return write(); // the same key: no second memory
  throw error;
});
```

The methods that write this way take `{ idempotencyKey, signal }` as their last argument. For an `AbortSignal` on any other request, use `call`: `rf.call("search", { body, signal })`.

## The contract and OpenAPI

`@rentfree/sdk/contract` is the contract on its own: the zod schema for every request and response, and every route with its method, path, who may call it, and the errors it can answer. The api validates with these schemas, so a body that parses here is one the api accepts.

```ts
import { contextBody, ROUTES, routeById } from "@rentfree/sdk/contract";

const body = contextBody.parse({ collectionId, query: "how do we deploy?" });
// body.tokenBudget is 2000: the schema's default

const userKeyOnly = ROUTES.filter((route) => route.auth === "userKey").map(
  (route) => route.id,
);
const { method, path } = routeById("context"); // "post", "/v1/context"
```

The OpenAPI 3.1 document, generated from the same contract, is at `@rentfree/sdk/openapi.json`, and the api serves it at `/api/openapi.json`. `buildOpenApiDocument({ version })` makes it again.

## Types

Everything the api answers has a type, inferred from its schema: `Memory`, `Session`, `SessionEvent`, `Source`, `Chunk`, `Collection`, `Agent`, `Key`, `ContextPack`, `RecapRun`, and the rest. For any route, `RouteInput<"id">` is what it takes and `RouteOutput<"id">` what it answers.

```ts
import type {
  ContextPack,
  Memory,
  RouteInput,
  RouteOutput,
} from "@rentfree/sdk";

type SearchBody = RouteInput<"search">["body"];
type SearchResult = RouteOutput<"search">;
```

Answers are not checked against the schemas at run time, so a newer api that adds a field does not break an older client.

## Runtimes

The client needs only `fetch`, so it runs on Node.js 20 and later, Bun, Deno, edge runtimes, and in a browser. Pass `fetch` to use one of your own. An API key in a browser can be read by anyone who opens the page, so keep keys on a server.

## Development

The source is in [rentfreeco/rentfree](https://github.com/rentfreeco/rentfree), beside the CLI. From the repository's root, with Node.js 24 and pnpm through Corepack:

```sh
corepack enable
pnpm install
pnpm build
pnpm test

# After changing a schema or a route: write openapi.json and the route table again
pnpm --filter @rentfree/sdk openapi
```

A test fails while `openapi.json` is out of date with the contract. Issues and pull requests are welcome; [CONTRIBUTING.md](https://github.com/rentfreeco/rentfree/blob/main/CONTRIBUTING.md) explains how a change gets in.

## Documentation

[rentfree.dev/docs/api](https://rentfree.dev/docs/api) is the API reference, generated from the same contract. The [`@rentfree/cli`](https://www.npmjs.com/package/@rentfree/cli) CLI is built on this package.

## Licence

MIT.
