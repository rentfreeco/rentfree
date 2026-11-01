/**
 * Writes `openapi.json` and `src/route-table.ts` from the contract. Run after changing a schema or a
 * route; the test in `src/openapi.test.ts` fails until the committed file
 * matches.
 */
import { writeFile } from "node:fs/promises";
import pkg from "../package.json" with { type: "json" };
import { buildOpenApiDocument, renderRouteTable } from "../src/openapi";

const file = new URL("../openapi.json", import.meta.url);
const document = buildOpenApiDocument({ version: pkg.version });
await writeFile(file, JSON.stringify(document, null, 2) + "\n");
await writeFile(
  new URL("../src/route-table.ts", import.meta.url),
  renderRouteTable(),
);
console.log(
  `openapi.json: ${Object.keys(document.paths).length} paths, ${
    Object.keys(document.components.schemas).length
  } schemas`,
);
