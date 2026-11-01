import { z } from "zod";
import {
  ERROR_STATUS,
  ROUTES,
  errorBody,
  errorsOf,
  needsIdempotencyKey,
  type RouteSpec,
} from "./contract";

type Json = Record<string, unknown>;

/**
 * The OpenAPI 3.1 document for the api, generated from the contract. Every
 * schema goes through `z.toJSONSchema`, whose 2020-12 dialect is the one
 * OpenAPI 3.1 uses. Schemas named with `.meta({ id })` become components
 * and are referenced; everything else is inlined.
 */
export function buildOpenApiDocument({
  version,
  serverUrl = "https://api.rentfree.dev/api",
}: {
  version: string;
  serverUrl?: string;
}) {
  const components: Record<string, Json> = {};

  /** A schema as JSON Schema, with its named parts lifted into components. */
  const toSchema = (schema: z.ZodType, io: "input" | "output"): Json => {
    const json = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io,
      unrepresentable: "any",
      // A named schema used once stays a reference, so components are complete.
      reused: "inline",
    }) as Json;
    const defs = (json.$defs ?? {}) as Record<string, Json>;
    delete json.$defs;
    delete json.$schema;
    for (const [name, def] of Object.entries(defs)) {
      components[name] ??= tidy(def) as Json;
    }
    // A schema that is itself named comes back as its definition with an
    // `id`; reference it instead.
    const named = z.globalRegistry.get(schema)?.id;
    if (typeof named === "string") {
      delete json.id;
      components[named] ??= tidy(json) as Json;
      return { $ref: `#/components/schemas/${named}` };
    }
    return tidy(json) as Json;
  };

  const paths: Record<string, Record<string, Json>> = {};
  for (const spec of ROUTES as readonly RouteSpec[]) {
    (paths[spec.path] ??= {})[spec.method] = operation(spec, toSchema);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "rentfree",
      version,
      summary: "Memory for AI agents.",
      description:
        "Agents log what they see and what they are given; rentfree turns it into searchable, attributable memories and hands back the context for the next turn, within a token budget. Every request under /v1 carries an API key as a bearer. Every POST under /v1 that writes takes an Idempotency-Key header.",
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: "memories", description: "What an agent should remember." },
      { name: "recall", description: "Search and the context pack." },
      { name: "sessions", description: "Logging what happens, as it happens." },
      { name: "sources", description: "Documents, URLs, and files." },
      { name: "recap", description: "Turning events into memories." },
      { name: "account", description: "Collections, agents, and keys." },
      { name: "login", description: "The browser login the CLI runs." },
      { name: "meta", description: "Liveness." },
    ],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "An API key: `rf_` and 43 characters.",
        },
        session: {
          type: "http",
          scheme: "bearer",
          description:
            "A Clerk session token from the web app; only the approval page uses it.",
        },
      },
    },
  };
}

function operation(
  spec: RouteSpec,
  toSchema: (schema: z.ZodType, io: "input" | "output") => Json,
): Json {
  const parameters: Json[] = [];
  for (const [where, schema] of [
    ["path", spec.params],
    ["query", spec.query],
  ] as const) {
    if (!schema) continue;
    const json = toSchema(schema, "input");
    const properties = (json.properties ?? {}) as Record<string, Json>;
    const required = new Set((json.required ?? []) as string[]);
    for (const [name, property] of Object.entries(properties)) {
      parameters.push({
        name,
        in: where,
        required: where === "path" || required.has(name),
        schema: property,
      });
    }
  }
  if (needsIdempotencyKey(spec)) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description:
        "1 to 255 printable characters, remembered for 24 hours. A retry with the same key and body replays the first answer.",
      schema: { type: "string", minLength: 1, maxLength: 255 },
    });
  }

  const responses: Record<string, Json> = {};
  for (const [status, schema] of Object.entries(spec.responses)) {
    responses[status] = schema
      ? {
          description: describeStatus(Number(status)),
          content: {
            "application/json": { schema: toSchema(schema, "output") },
          },
        }
      : { description: describeStatus(Number(status)) };
  }
  // Errors grouped by status, each naming the codes it can carry.
  const byStatus = new Map<number, string[]>();
  for (const code of errorsOf(spec)) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const error = toSchema(errorBody, "output");
  for (const [status, codes] of byStatus) {
    responses[String(status)] = {
      description: codes.map((code) => `\`${code}\``).join(", "),
      content: { "application/json": { schema: error } },
    };
  }

  return {
    operationId: spec.id,
    tags: [spec.tag],
    summary: spec.summary,
    ...(spec.auth === "none"
      ? { security: [] }
      : {
          security: [{ [spec.auth === "session" ? "session" : "apiKey"]: [] }],
        }),
    ...(spec.auth === "userKey"
      ? {
          description:
            "Takes a user-level key; an agent key is refused with 403.",
        }
      : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(spec.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: toSchema(spec.body, "input") },
            },
          },
        }
      : {}),
    responses,
  };
}

/**
 * The route table as plain data: each route's method and path by its id.
 * The client reads this instead of the contract, so making a request never
 * loads zod or builds a schema.
 */
export function renderRouteTable(): string {
  const rows = (ROUTES as readonly RouteSpec[])
    .map((r) => `  ${r.id}: ["${r.method}", "${r.path}"],`)
    .join("\n");
  return `// Generated by \`pnpm --filter @rentfree/sdk openapi\` from the contract's
// route table. Do not edit; \`src/openapi.test.ts\` fails when it is stale.
export const ROUTE_TABLE = {
${rows}
} as const;
`;
}

function describeStatus(status: number): string {
  return (
    {
      200: "OK",
      201: "Created",
      202: "Accepted; the work continues in the background",
      204: "Done; no body",
      503: "The database is unreachable",
    }[status] ?? String(status)
  );
}

/**
 * Rewrites `$defs` references to components, and drops the regular
 * expression zod attaches to every date-time: `format` says it, and the
 * pattern is a page long.
 */
function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (value === null || typeof value !== "object") return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref" && typeof v === "string") {
      out[k] = v.replace("#/$defs/", "#/components/schemas/");
    } else if (k === "pattern" && (value as Json).format === "date-time") {
      continue;
    } else if (k === "id" && typeof v === "string") {
      continue;
    } else {
      out[k] = tidy(v);
    }
  }
  return out;
}
