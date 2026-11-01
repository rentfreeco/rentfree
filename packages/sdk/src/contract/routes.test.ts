import { describe, expect, test } from "vitest";
import { createSourceBody, eventBody } from "./index";
import {
  ROUTES,
  errorsOf,
  matchRoute,
  routeById,
  type RouteSpec,
} from "./routes";

describe("the route table", () => {
  test("names every route once, and every method and path once", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("gives every path parameter a schema, and every schema a path parameter", () => {
    for (const r of ROUTES as readonly RouteSpec[]) {
      const inPath = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = r.params
        ? Object.keys((r.params as unknown as { shape: object }).shape)
        : [];
      expect(declared, r.id).toEqual(inPath);
    }
  });

  test("matches a request to its route, literal segments first", () => {
    expect(matchRoute("GET", "/v1/sources/abc/content")?.id).toBe(
      "getSourceContent",
    );
    expect(matchRoute("GET", "/v1/sources/abc")?.id).toBe("getSource");
    expect(matchRoute("POST", "/auth/device/poll")?.id).toBe("pollLogin");
    expect(matchRoute("GET", "/auth/device/HJKD-MPQR")?.id).toBe("getLogin");
    expect(matchRoute("GET", "/v1/memories?collectionId=c")?.id).toBe(
      "listMemories",
    );
    expect(matchRoute("PUT", "/v1/memories/m1")).toBeUndefined();
  });

  test("adds the errors every route of a kind can answer", () => {
    expect(errorsOf(routeById("remember"))).toEqual([
      "invalid_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "collection_archived",
      "idempotency_key_in_progress",
      "idempotency_key_reused",
      "internal",
    ]);
    expect(errorsOf(routeById("health"))).toEqual(["internal"]);
    expect(errorsOf(routeById("listKeys"))).toContain("forbidden");
  });
});

describe("the request schemas", () => {
  test("default a source with no kind to text", () => {
    const parsed = createSourceBody.parse({ content: "# Notes\nhello" });
    expect(parsed).toMatchObject({ kind: "text", metadata: {} });
  });

  test("measure metadata in UTF-8 bytes, without Node", () => {
    const big = { note: "é".repeat(8200) }; // 16,400 bytes as UTF-8
    const result = eventBody.safeParse({
      type: "note",
      content: "x",
      metadata: big,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "metadata must be 16 KB or less",
    );
  });
});
