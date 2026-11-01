# @rentfree/sdk

The TypeScript client for [rentfree](https://rentfree.dev), memory for AI agents, and the contract it is typed by.

```sh
npm install @rentfree/sdk
```

```ts
import { createClient } from "@rentfree/sdk";

const rf = createClient({ apiKey: process.env.RF_API_KEY });

// The one call an agent makes per turn: text for its prompt, within a budget.
const pack = await rf.context({
  collectionId,
  query: "how do we deploy?",
  tokenBudget: 1500,
});

// Log a conversation; the same externalId always finds the same session.
const { session } = await rf.sessions.start({ externalId: "my-agent:run-42" });
await rf.sessions.log(session.id, {
  events: [
    { type: "message.user", content: "How do we deploy?" },
    { type: "message.assistant", content: "From main, once CI is green." },
  ],
});
await rf.sessions.end(session.id); // starts a recap into memories

await rf.remember({
  collectionId,
  type: "fact",
  tier: "long",
  content: "Deploys need green CI.",
});
const found = await rf.search({ query: "deploy" });
```

## What it gives you

- **One method per endpoint**, typed by the api's own schemas: a required field is required, a closed vocabulary is closed. `rf.call(routeId, input)` reaches any endpoint by its id.
- **Requests done right**: the key as a bearer, an `Idempotency-Key` on every write so a retry is safe, and `RentfreeError` with the api's `code` and `issues` when it refuses. A request that got no answer is `RentfreeUnreachable`.
- **The helpers that are more than one request**: `sources.addFile` (upload, then create), `sources.waitReady`, `recap.runAndWait`, and `all` iterators that follow cursors.
- **The contract** at `@rentfree/sdk/contract`: the zod schema for every request and response, and the route table. The OpenAPI 3.1 document is at `@rentfree/sdk/openapi.json`.
- **Bring your own `fetch`**: it runs on Node 20 and later, Bun, Deno, edge runtimes, and browsers.

## Documentation

[rentfree.dev/docs/api](https://rentfree.dev/docs/api) is the API reference, generated from the same contract. The [`@rentfree/cli`](https://www.npmjs.com/package/@rentfree/cli) CLI is built on this package.

## Licence

MIT.
