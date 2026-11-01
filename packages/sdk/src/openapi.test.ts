import { readFile } from "node:fs/promises";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { buildOpenApiDocument, renderRouteTable } from "./openapi";

const committed = async () =>
  JSON.parse(
    await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
  ) as unknown;

describe("the OpenAPI document", () => {
  test("is what the contract generates; run `pnpm openapi` after changing it", async () => {
    // Round-trip through JSON so undefined fields compare as the file has them.
    const fresh = JSON.parse(
      JSON.stringify(buildOpenApiDocument({ version: pkg.version })),
    ) as unknown;
    expect(await committed()).toEqual(fresh);
  });

  test("comes with a route table that matches it; run `pnpm openapi` after changing it", async () => {
    const table = await readFile(
      new URL("./route-table.ts", import.meta.url),
      "utf8",
    );
    expect(table).toBe(renderRouteTable());
  });

  test("is valid OpenAPI 3.1", async () => {
    const validator = new Validator();
    const result = await validator.validate(
      (await committed()) as Record<string, unknown>,
    );
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe("3.1");
  });

  test("references only components it defines", async () => {
    const text = JSON.stringify(await committed());
    const document = JSON.parse(text) as {
      components: { schemas: Record<string, unknown> };
    };
    const refs = [...text.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const name of new Set(refs)) {
      expect(document.components.schemas).toHaveProperty(name);
    }
    expect(text).not.toContain("#/$defs/");
  });

  test("asks for an Idempotency-Key on writes and not on the reads sent as POST", () => {
    const { paths } = buildOpenApiDocument({ version: "0" });
    const headerOf = (path: string, method: string) =>
      (
        (paths[path]![method]!.parameters ?? []) as Array<{
          name: string;
          in: string;
        }>
      ).find((p) => p.in === "header" && p.name === "Idempotency-Key");
    expect(headerOf("/v1/memories", "post")).toBeDefined();
    expect(headerOf("/v1/search", "post")).toBeUndefined();
    expect(headerOf("/v1/context", "post")).toBeUndefined();
    expect(headerOf("/auth/device", "post")).toBeUndefined();
    expect(headerOf("/v1/memories/{id}", "patch")).toBeUndefined();
  });
});
