import { describe, expect, expectTypeOf, test } from "vitest";
import { createClient } from "./client";
import type { Memory, SearchResult } from "./contract";
import { RentfreeError, RentfreeTimeout, RentfreeUnreachable } from "./errors";
import { fakeFetch, type Canned } from "./test/fake-fetch";
import { memory, recapRun, session, source } from "./test/fixtures";

const base = "https://api.test/api";

function client(answers: Canned[], extra: { apiKey?: string | null } = {}) {
  const fake = fakeFetch(answers, base);
  let clock = 0;
  const slept: number[] = [];
  const rf = createClient({
    apiKey: "apiKey" in extra ? extra.apiKey : "rf_test",
    baseUrl: base,
    fetch: fake.fetch,
    idempotencyKey: () => "idem-1",
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { rf, ...fake, slept };
}

describe("requests", () => {
  test("send the key as a bearer and fill in path and query", async () => {
    const { rf, seen } = client([
      {
        method: "GET",
        path: "/v1/memories",
        status: 200,
        body: { items: [], nextCursor: null },
      },
      {
        method: "GET",
        path: "/v1/memories/m%2F1",
        status: 200,
        body: memory(),
      },
    ]);
    await rf.memories.list({ collectionId: "col 1", limit: 5 });
    await rf.memories.get("m/1");
    expect(seen[0]!.url.search).toBe("?collectionId=col+1&limit=5");
    expect(seen[0]!.headers.authorization).toBe("Bearer rf_test");
    expect(seen[1]!.url.pathname).toBe("/api/v1/memories/m%2F1");
  });

  test("put an Idempotency-Key on writes, and none on reads sent as POST", async () => {
    const { rf, seen } = client([
      { method: "POST", path: "/v1/memories", status: 201, body: memory() },
      { method: "POST", path: "/v1/memories", status: 201, body: memory() },
      {
        method: "POST",
        path: "/v1/search",
        status: 200,
        body: { mode: "text", memories: [], chunks: [] },
      },
      {
        method: "PATCH",
        path: "/v1/memories/mem_1",
        status: 200,
        body: memory(),
      },
    ]);
    const body = {
      collectionId: "col_1",
      type: "fact",
      tier: "long",
      content: "x",
    } as const;
    await rf.remember(body);
    await rf.remember(body, { idempotencyKey: "mine" });
    await rf.search({ query: "fridays" });
    await rf.memories.update("mem_1", { importance: 0.9 });
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual([
      "idem-1",
      "mine",
      undefined,
      undefined,
    ]);
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(seen[0]!.body).toEqual(body);
  });

  test("send no key when there is none, for the login", async () => {
    const { rf, seen } = client(
      [
        {
          method: "POST",
          path: "/auth/device",
          status: 201,
          body: {
            deviceCode: "d",
            userCode: "HJKD-MPQR",
            verifyUrl: "https://rentfree.dev/cli?code=HJKD-MPQR",
            expiresIn: 600,
            interval: 5,
          },
        },
      ],
      { apiKey: null },
    );
    const started = await rf.login.start({ name: "CLI on test" });
    expect(started.userCode).toBe("HJKD-MPQR");
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  test("answer nothing for a 204", async () => {
    const { rf } = client([
      { method: "DELETE", path: "/v1/sources/src_1", status: 204 },
    ]);
    await expect(rf.sources.remove("src_1")).resolves.toBeUndefined();
  });

  test("say whether a session was started or found", async () => {
    const { rf } = client([
      {
        method: "POST",
        path: "/v1/sessions",
        status: 201,
        body: session({ externalId: "cc:1" }),
      },
      {
        method: "POST",
        path: "/v1/sessions",
        status: 200,
        body: session({ externalId: "cc:1" }),
      },
    ]);
    expect((await rf.sessions.start({ externalId: "cc:1" })).created).toBe(
      true,
    );
    expect((await rf.sessions.start({ externalId: "cc:1" })).created).toBe(
      false,
    );
  });
});

describe("failures", () => {
  test("an error answer is a RentfreeError with the api's code and issues", async () => {
    const { rf } = client([
      {
        method: "POST",
        path: "/v1/memories",
        status: 400,
        body: {
          error: "invalid_request",
          issues: [{ path: "expiresAt", message: "Must be in the future" }],
        },
      },
      {
        method: "GET",
        path: "/v1/memories/nope",
        status: 404,
        body: { error: "not_found" },
      },
    ]);
    const bad = await rf
      .remember({
        collectionId: "c",
        type: "fact",
        tier: "working",
        content: "x",
      })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(RentfreeError);
    expect(bad).toMatchObject({
      status: 400,
      code: "invalid_request",
      route: "remember",
    });
    expect((bad as Error).message).toBe(
      "invalid_request: expiresAt: Must be in the future",
    );
    await expect(rf.memories.get("nope")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  test("a body that is not JSON still gives a code", async () => {
    const rf = createClient({
      baseUrl: base,
      fetch: async () =>
        new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await expect(rf.health()).rejects.toMatchObject({
      code: "http_502",
      status: 502,
    });
  });

  test("a network failure is RentfreeUnreachable", async () => {
    const rf = createClient({
      baseUrl: base,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await rf.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RentfreeUnreachable);
    expect((error as Error).message).toBe(
      `Could not reach ${base}/health: fetch failed`,
    );
  });

  test("a missing path parameter is caught before any request", async () => {
    const { rf, seen } = client([]);
    await expect(rf.memories.get("")).rejects.toThrow(
      "missing path parameter id",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("helpers", () => {
  test("`all` follows cursors to the end", async () => {
    const { rf, seen } = client([
      {
        method: "GET",
        path: "/v1/memories",
        status: 200,
        body: {
          items: [memory({ id: "a" }), memory({ id: "b" })],
          nextCursor: "c1",
        },
      },
      {
        method: "GET",
        path: "/v1/memories",
        status: 200,
        body: { items: [memory({ id: "c" })], nextCursor: null },
      },
    ]);
    const ids: string[] = [];
    for await (const m of rf.memories.all({ collectionId: "col_1" }))
      ids.push(m.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(seen[1]!.url.searchParams.get("cursor")).toBe("c1");
  });

  test("addFile uploads the bytes without the key, then makes the source", async () => {
    const { rf, seen } = client([
      {
        method: "POST",
        path: "/v1/uploads",
        status: 201,
        body: {
          blobKey: "uploads/u/k/notes.pdf",
          uploadUrl: "https://blob.test/put/abc",
          method: "PUT",
          headers: { "content-type": "application/pdf" },
          expiresAt: "2026-10-19T12:10:00.000Z",
        },
      },
      { method: "PUT", path: "https://blob.test/put/abc", status: 200 },
      {
        method: "POST",
        path: "/v1/sources",
        status: 202,
        body: source({ kind: "file", status: "pending" }),
      },
    ]);
    const made = await rf.sources.addFile({
      filename: "notes.pdf",
      contentType: "application/pdf",
      data: new Uint8Array([1, 2, 3]),
      title: "Notes",
      externalId: "file:/home/me/notes.pdf",
    });
    expect(made.status).toBe("pending");
    expect(seen[0]!.body).toEqual({
      filename: "notes.pdf",
      contentType: "application/pdf",
      size: 3,
    });
    expect(seen[1]!.headers.authorization).toBeUndefined();
    expect(seen[1]!.headers["content-type"]).toBe("application/pdf");
    expect(seen[2]!.body).toEqual({
      kind: "file",
      blobKey: "uploads/u/k/notes.pdf",
      title: "Notes",
      externalId: "file:/home/me/notes.pdf",
    });
  });

  test("addFile reports a refused upload", async () => {
    const { rf } = client([
      {
        method: "POST",
        path: "/v1/uploads",
        status: 201,
        body: {
          blobKey: "k",
          uploadUrl: "https://blob.test/put/x",
          method: "PUT",
          headers: { "content-type": "text/plain" },
          expiresAt: "2026-10-19T12:10:00.000Z",
        },
      },
      { method: "PUT", path: "https://blob.test/put/x", status: 403 },
    ]);
    await expect(
      rf.sources.addFile({
        filename: "a.txt",
        contentType: "text/plain",
        data: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: "upload_failed", status: 403 });
  });

  test("waitReady polls until the source is ready, then gives up on a slow one", async () => {
    const { rf, slept } = client([
      {
        method: "GET",
        path: "/v1/sources/src_1",
        status: 200,
        body: source({ status: "pending" }),
      },
      {
        method: "GET",
        path: "/v1/sources/src_1",
        status: 200,
        body: source({ status: "processing" }),
      },
      {
        method: "GET",
        path: "/v1/sources/src_1",
        status: 200,
        body: source({ status: "ready" }),
      },
      {
        method: "GET",
        path: "/v1/sources/src_2",
        status: 200,
        body: source({ id: "src_2", status: "pending" }),
      },
      {
        method: "GET",
        path: "/v1/sources/src_2",
        status: 200,
        body: source({ id: "src_2", status: "pending" }),
      },
    ]);
    expect(
      (await rf.sources.waitReady("src_1", { intervalMs: 500 })).status,
    ).toBe("ready");
    expect(slept).toEqual([500, 500]);
    await expect(
      rf.sources.waitReady("src_2", { intervalMs: 1000, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(RentfreeTimeout);
  });

  test("runAndWait waits for the new run to finish, and answers null when idle", async () => {
    const { rf } = client([
      {
        method: "GET",
        path: "/v1/recap/runs",
        status: 200,
        body: { runs: [recapRun({ id: "old" })] },
      },
      {
        method: "POST",
        path: "/v1/recap/run",
        status: 202,
        body: { status: "started", unread: 4 },
      },
      {
        method: "GET",
        path: "/v1/recap/runs",
        status: 200,
        body: { runs: [recapRun({ id: "old" })] },
      },
      {
        method: "GET",
        path: "/v1/recap/runs",
        status: 200,
        body: {
          runs: [recapRun({ id: "new", status: "running", finishedAt: null })],
        },
      },
      {
        method: "GET",
        path: "/v1/recap/runs",
        status: 200,
        body: { runs: [recapRun({ id: "new" })] },
      },
      {
        method: "GET",
        path: "/v1/recap/runs",
        status: 200,
        body: { runs: [] },
      },
      {
        method: "POST",
        path: "/v1/recap/run",
        status: 200,
        body: { status: "idle" },
      },
    ]);
    expect((await rf.recap.runAndWait({ intervalMs: 10 }))?.id).toBe("new");
    expect(await rf.recap.runAndWait()).toBeNull();
  });
});

describe("types", () => {
  test("come from the contract", () => {
    const rf = createClient({ fetch: async () => new Response("{}") });
    expectTypeOf(rf.memories.get).returns.resolves.toEqualTypeOf<Memory>();
    expectTypeOf(rf.search).returns.resolves.toEqualTypeOf<SearchResult>();
    expectTypeOf(rf.sources.remove).returns.resolves.toEqualTypeOf<void>();
    expectTypeOf(rf.call<"getMemory">)
      .parameter(1)
      .toHaveProperty("params")
      .toEqualTypeOf<{ id: string }>();
    // A required query field is required; an all-optional query may be left out.
    // @ts-expect-error collectionId is required
    void (() => rf.memories.list({}));
    void (() => rf.call("listKeys", {}));
    const shortTier = { collectionId: "c", type: "fact", tier: "short" };
    // @ts-expect-error tier is a closed vocabulary
    void (() => rf.remember({ ...shortTier, content: "x" }));
  });
});
