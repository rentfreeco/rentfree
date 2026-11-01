import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ApiError,
  ApiUnreachable,
  Fetch,
  NotLoggedIn,
  describeFailure,
  makeApi,
  type Api,
} from "./client";
import type { Settings } from "./config";
import { fakeApi, fakePlatform } from "./test/fakes";

const settings: Settings = {
  apiUrl: "https://api.example.com",
  apiKey: "rf_" + "k".repeat(43),
  keySource: "profile",
  agentCaller: null,
  profile: "default",
  project: null,
  projectFile: null,
  defaultCollectionId: null,
};

/** Runs a use of the api against a fake, answering its value or its failure. */
const run = <A>(
  layer: Layer.Layer<Fetch>,
  use: (api: Api) => Effect.Effect<A, unknown>,
  s: Settings = settings,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(makeApi(s), use).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((failure) =>
          Effect.succeed({ ok: false as const, failure }),
        ),
      ),
      Layer.merge(layer, fakePlatform().layer),
    ),
  );

describe("the api client", () => {
  test("sends the key as a bearer through the SDK, and answers the body", async () => {
    const fake = fakeApi([
      { path: "/api/v1/me", body: { user: { id: "user_1" } } },
    ]);
    const result = await run(fake.layer, (api) => api.run((rf) => rf.me.get()));
    expect(result).toMatchObject({
      ok: true,
      value: { user: { id: "user_1" } },
    });
    expect(fake.seen).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://api.example.com/api/v1/me",
        headers: expect.objectContaining({
          authorization: `Bearer ${settings.apiKey}`,
          accept: "application/json",
          "user-agent": expect.stringMatching(/^rf\//),
        }),
      }),
    ]);
  });

  test("gives every write a fresh Idempotency-Key", async () => {
    const fake = fakeApi([
      {
        method: "POST",
        path: "/api/v1/collections",
        status: 201,
        body: { id: "col_1" },
      },
    ]);
    const create = (api: Api) =>
      api.run((rf) => rf.collections.create({ name: "work" }));
    await run(fake.layer, create);
    await run(fake.layer, create);
    expect(fake.seen.map((s) => s.body)).toEqual([
      { name: "work" },
      { name: "work" },
    ]);
    const keys = fake.seen.map((s) => s.headers["idempotency-key"]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("refuses to send anything without a key", async () => {
    const fake = fakeApi([]);
    const result = await run(
      fake.layer,
      (api) => api.run((rf) => rf.me.get()),
      { ...settings, apiKey: null },
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.failure).toBeInstanceOf(NotLoggedIn);
    expect(fake.seen).toEqual([]);
  });

  test("reads a 401 as not logged in, and an error body as the api's refusal", async () => {
    const fake = fakeApi([
      { path: "/api/v1/me", status: 401, body: { error: "unauthorized" } },
      {
        method: "POST",
        path: "/api/v1/agents",
        status: 400,
        body: {
          error: "invalid_request",
          issues: [
            {
              path: "readCollectionIds",
              message: "Not one of your collections: col_x",
            },
          ],
        },
      },
    ]);
    const me = await run(fake.layer, (api) => api.run((rf) => rf.me.get()));
    expect(!me.ok && me.failure).toBeInstanceOf(NotLoggedIn);

    const refused = await run(fake.layer, (api) =>
      api.run((rf) =>
        rf.agents.create({
          name: "x",
          canReadMemories: true,
          canWriteMemories: true,
          readCollectionIds: ["col_x"],
          writeCollectionIds: [],
        }),
      ),
    );
    const failure = !refused.ok ? refused.failure : null;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 400,
      error: "invalid_request",
      issues: [
        {
          path: "readCollectionIds",
          message: "Not one of your collections: col_x",
        },
      ],
    });
    expect(describeFailure(failure as ApiError)).toBe(
      "The api refused the request (invalid_request): readCollectionIds: Not one of your collections: col_x",
    );
  });

  test("reads a request that got no answer as the api being unreachable", async () => {
    const layer = Layer.succeed(Fetch, async () => {
      throw new TypeError("fetch failed");
    });
    const result = await run(layer, (api) => api.run((rf) => rf.me.get()));
    expect(!result.ok && result.failure).toBeInstanceOf(ApiUnreachable);
    expect(
      !result.ok && describeFailure(result.failure as ApiUnreachable),
    ).toBe("Could not reach the api at https://api.example.com: fetch failed");
  });

  test("describes each failure in one line", () => {
    expect(describeFailure(new NotLoggedIn())).toBe(
      "Not logged in. Run `rf init`, or set RF_API_KEY.",
    );
    expect(
      describeFailure(
        new ApiUnreachable({ url: "http://x", detail: "ECONNREFUSED" }),
      ),
    ).toBe("Could not reach the api at http://x: ECONNREFUSED");
    expect(
      describeFailure(
        new ApiError({ status: 500, error: "internal", issues: [] }),
      ),
    ).toBe("The api refused the request (internal, HTTP 500).");
  });
});
