import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isolatedEnvironment, runRf, type Canned } from "../test/fakes";

const KEY = "rf_" + "k".repeat(43);

const col = (id: string, name: string, isDefault = false) => ({
  id,
  name,
  isDefault,
  createdAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
});

const agent = (id: string, name: string, write = true) => ({
  id,
  name,
  canReadMemories: true,
  canWriteMemories: write,
  readCollectionIds: ["col_1"],
  writeCollectionIds: write ? ["col_1"] : [],
  createdAt: "2026-10-01T00:00:00.000Z",
  revokedAt: null,
});

const key = (id: string, name: string, agentId: string | null = null) => ({
  id,
  name,
  keyPrefix: `rf_${id.padEnd(8, "x")}`,
  agentId,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
});

const me = {
  user: {
    id: "user_1",
    email: "eddie@example.com",
    embedModel: "m",
    embedDimensions: null,
  },
  caller: {
    agentId: null,
    apiKeyId: "key_1",
    keyPrefix: KEY.slice(0, 11),
    keyName: "CLI",
  },
  collections: [col("col_1", "default", true), col("col_2", "work")],
  agents: [],
};

const requests = (seen: { method: string; url: string }[]) =>
  seen.map(
    (s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`,
  );

describe("account commands", () => {
  const env = isolatedEnvironment();
  beforeEach(async () => {
    await env.setup();
    process.env.RF_API_KEY = KEY;
    process.env.RF_API_URL = "https://api.example.com";
  });
  afterEach(() => env.teardown());

  describe("rf keys", () => {
    test("lists live keys, and revoked ones on request", async () => {
      const answers: Canned[] = [
        {
          path: "/api/v1/keys",
          body: {
            keys: [key("key_1", "CLI on mac"), key("key_2", "ci", "agent_1")],
          },
        },
      ];
      const live = await runRf(["keys", "list"], answers);
      expect(requests(live.seen)).toEqual(["GET /api/v1/keys?status=active"]);
      expect(live.out).toBe(
        [
          "id     prefix        name        for            last used",
          "key_1  rf_key_1xxx…  CLI on mac  user-level     -",
          "key_2  rf_key_2xxx…  ci          agent agent_1  -",
        ].join("\n"),
      );
      const revoked = await runRf(
        ["keys", "list", "--revoked"],
        [{ path: "/api/v1/keys", body: { keys: [] } }],
      );
      expect(requests(revoked.seen)).toEqual([
        "GET /api/v1/keys?status=revoked",
      ]);
      expect(revoked.out).toBe("No revoked keys.");
    });

    test("mints a key and shows the secret once", async () => {
      const minted = {
        ...key("key_9", "CI on GitHub", "agent_1"),
        apiKey: "rf_" + "n".repeat(43),
      };
      const { out, seen } = await runRf(
        ["keys", "create", "--name", "CI on GitHub", "--agent", "agent_1"],
        [{ method: "POST", path: "/api/v1/keys", status: 201, body: minted }],
      );
      expect(seen[0]!.body).toEqual({
        name: "CI on GitHub",
        agentId: "agent_1",
      });
      expect(seen[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(out).toContain("Shown once");
      expect(out).toContain("rf_" + "n".repeat(43));
    });

    test("with --use, stores the agent's key and names the agent in rf.json", async () => {
      const minted = {
        ...key("key_9", "proj", "agent_1"),
        apiKey: "rf_" + "n".repeat(43),
      };
      const { out, exitCode } = await runRf(
        ["keys", "create", "--name", "proj", "--agent", "agent_1", "--use"],
        [{ method: "POST", path: "/api/v1/keys", status: 201, body: minted }],
      );
      expect(exitCode).toBeUndefined();
      expect(out).toContain("rf.json now names agent agent_1");
      const stored = JSON.parse(await readFile(env.credentialsFile, "utf8"));
      expect(stored.agents.agent_1).toEqual({
        apiKey: minted.apiKey,
        keyPrefix: minted.keyPrefix,
      });
      expect(
        JSON.parse(await readFile(join(env.cwd, "rf.json"), "utf8")),
      ).toEqual({ agentId: "agent_1" });
      // Without an agent, --use makes no sense.
      const bad = await runRf(
        ["keys", "create", "--name", "x", "--use"],
        [{ method: "POST", path: "/api/v1/keys", status: 201, body: minted }],
      );
      expect(bad.exitCode).toBe(1);
      expect(bad.err).toContain("--use needs --agent");
    });

    test("revokes a key by id or prefix", async () => {
      const answers: Canned[] = [
        {
          path: "/api/v1/keys",
          body: { keys: [key("key_1", "a"), key("key_2", "b")] },
        },
        {
          method: "DELETE",
          path: "/api/v1/keys/key_2",
          body: { ...key("key_2", "b"), revokedAt: "2026-10-19T00:00:00.000Z" },
        },
      ];
      const byPrefix = await runRf(["keys", "revoke", "rf_key_2xxx…"], answers);
      expect(requests(byPrefix.seen)).toEqual([
        "GET /api/v1/keys?status=active",
        "DELETE /api/v1/keys/key_2",
      ]);
      expect(byPrefix.out).toBe("Revoked key rf_key_2xxx… (b).");
      const unknown = await runRf(["keys", "revoke", "key_9"], answers);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.err).toContain("No live key");
    });
  });

  describe("rf agents", () => {
    test("lists agents with their permissions", async () => {
      const { out } = await runRf(
        ["agents", "list"],
        [
          {
            path: "/api/v1/agents",
            body: {
              agents: [
                agent("agent_1", "claude-code"),
                agent("agent_2", "reader", false),
              ],
            },
          },
        ],
      );
      expect(out).toBe(
        [
          "id       name         read  write  collections",
          "agent_1  claude-code  yes   yes    col_1",
          "agent_2  reader       yes   no     col_1",
        ].join("\n"),
      );
      const none = await runRf(
        ["agents", "list"],
        [{ path: "/api/v1/agents", body: { agents: [] } }],
      );
      expect(none.out).toContain("No agents.");
    });

    test("creates an agent on the default collection with read and write", async () => {
      const { out, seen } = await runRf(
        ["agents", "create", "claude-code"],
        [
          { path: "/api/v1/me", body: me },
          {
            method: "POST",
            path: "/api/v1/agents",
            status: 201,
            body: agent("agent_7", "claude-code"),
          },
        ],
      );
      expect(seen[1]!.body).toEqual({
        name: "claude-code",
        canReadMemories: true,
        canWriteMemories: true,
        readCollectionIds: ["col_1"],
        writeCollectionIds: ["col_1"],
      });
      expect(out).toContain(
        "Created agent agent_7 (claude-code): read and write on col_1.",
      );
      expect(out).toContain("rf keys create --name <name> --agent agent_7");
    });

    test("creates a read-only agent on named collections, and with --use stores its key", async () => {
      const minted = {
        ...key("key_9", "claude-code on this machine", "agent_7"),
        apiKey: "rf_" + "n".repeat(43),
      };
      const { out, seen } = await runRf(
        [
          "agents",
          "create",
          "reader",
          "--read-only",
          "--collections",
          "col_1, col_2",
          "--use",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/agents",
            status: 201,
            body: agent("agent_7", "reader", false),
          },
          { method: "POST", path: "/api/v1/keys", status: 201, body: minted },
        ],
      );
      expect(requests(seen)).toEqual([
        "POST /api/v1/agents",
        "POST /api/v1/keys",
      ]);
      expect(seen[0]!.body).toMatchObject({
        canWriteMemories: false,
        readCollectionIds: ["col_1", "col_2"],
        writeCollectionIds: [],
      });
      expect(seen[1]!.body).toEqual({
        name: "reader on this machine",
        agentId: "agent_7",
      });
      expect(out).toContain("read-only on col_1, col_2");
      expect(out).toContain(minted.apiKey);
      expect(
        JSON.parse(await readFile(join(env.cwd, "rf.json"), "utf8")),
      ).toEqual({ agentId: "agent_7" });
    });

    test("edits an agent, deriving the write list from its permission", async () => {
      const current = agent("agent_1", "claude-code");
      const edited = await runRf(
        [
          "agents",
          "edit",
          "agent_1",
          "--collections",
          "col_1,col_2",
          "--name",
          "cc",
        ],
        [
          { path: "/api/v1/agents", body: { agents: [current] } },
          {
            method: "PATCH",
            path: "/api/v1/agents/agent_1",
            body: {
              ...current,
              name: "cc",
              readCollectionIds: ["col_1", "col_2"],
              writeCollectionIds: ["col_1", "col_2"],
            },
          },
        ],
      );
      expect(edited.seen[1]!.body).toEqual({
        name: "cc",
        readCollectionIds: ["col_1", "col_2"],
        writeCollectionIds: ["col_1", "col_2"],
      });
      expect(edited.out).toContain("col_1,col_2");

      const readOnly = await runRf(
        ["agents", "edit", "agent_1", "--read-only"],
        [
          { path: "/api/v1/agents", body: { agents: [current] } },
          {
            method: "PATCH",
            path: "/api/v1/agents/agent_1",
            body: {
              ...current,
              canWriteMemories: false,
              writeCollectionIds: [],
            },
          },
        ],
      );
      expect(readOnly.seen[1]!.body).toEqual({
        canWriteMemories: false,
        writeCollectionIds: [],
      });

      const both = await runRf(
        ["agents", "edit", "agent_1", "--read-only", "--read-write"],
        [],
      );
      expect(both.exitCode).toBe(1);
      const nothing = await runRf(
        ["agents", "edit", "agent_1"],
        [{ path: "/api/v1/agents", body: { agents: [current] } }],
      );
      expect(nothing.exitCode).toBe(1);
      expect(nothing.err).toContain("Nothing to change");
    });

    test("revokes an agent and reports its keys", async () => {
      const { out } = await runRf(
        ["agents", "revoke", "agent_1"],
        [
          {
            method: "DELETE",
            path: "/api/v1/agents/agent_1",
            body: {
              agent: { ...agent("agent_1", "claude-code"), revokedAt: "x" },
              keysRevoked: 2,
            },
          },
        ],
      );
      expect(out).toBe(
        "Revoked agent agent_1 (claude-code) and 2 of its keys.",
      );
    });
  });

  describe("rf collections", () => {
    test("lists, creates, renames, defaults, and archives", async () => {
      const listed = await runRf(
        ["collections", "list"],
        [
          {
            path: "/api/v1/collections",
            body: {
              collections: [
                col("col_1", "default", true),
                col("col_2", "work"),
              ],
            },
          },
        ],
      );
      expect(listed.out).toBe(
        [
          "id     name     default",
          "col_1  default  default",
          "col_2  work     ",
        ].join("\n"),
      );

      const created = await runRf(
        ["collections", "create", "notes"],
        [
          {
            method: "POST",
            path: "/api/v1/collections",
            status: 201,
            body: col("col_3", "notes"),
          },
        ],
      );
      expect(created.seen[0]!.body).toEqual({ name: "notes" });
      expect(created.out).toBe("Created collection col_3  notes");

      const renamed = await runRf(
        ["collections", "rename", "col_3", "journal"],
        [
          {
            method: "PATCH",
            path: "/api/v1/collections/col_3",
            body: col("col_3", "journal"),
          },
        ],
      );
      expect(renamed.seen[0]!.body).toEqual({ name: "journal" });

      const defaulted = await runRf(
        ["collections", "set-default", "col_3"],
        [
          {
            method: "PATCH",
            path: "/api/v1/collections/col_3",
            body: col("col_3", "journal", true),
          },
        ],
      );
      expect(defaulted.seen[0]!.body).toEqual({ isDefault: true });
      expect(defaulted.out).toBe(
        "Default collection is now col_3  journal  (default)",
      );

      const archived = await runRf(
        ["collections", "archive", "col_2"],
        [
          {
            method: "DELETE",
            path: "/api/v1/collections/col_2",
            body: {
              ...col("col_2", "work"),
              archivedAt: "2026-10-19T00:00:00.000Z",
            },
          },
        ],
      );
      expect(archived.out).toContain("Archived collection col_2 (work)");

      const refused = await runRf(
        ["collections", "archive", "col_1"],
        [
          {
            method: "DELETE",
            path: "/api/v1/collections/col_1",
            status: 409,
            body: { error: "collection_default" },
          },
        ],
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.err).toBe(
        "The api refused the request (collection_default, HTTP 409).",
      );
    });
  });

  describe("rf config", () => {
    test("sets the embedding model, with or without a size", async () => {
      const sized = await runRf(
        ["config", "set", "embed-model", "openai/text-embedding-3-large@1024"],
        [
          {
            method: "PATCH",
            path: "/api/v1/me",
            body: {
              embedModel: "openai/text-embedding-3-large",
              embedDimensions: 1024,
            },
          },
        ],
      );
      expect(sized.seen[0]!.body).toEqual({
        embedModel: "openai/text-embedding-3-large",
        embedDimensions: 1024,
      });
      expect(sized.out).toBe(
        "Embedding model is now openai/text-embedding-3-large@1024.",
      );
      const plain = await runRf(
        ["config", "set", "embed-model", "voyage/voyage-4-lite"],
        [
          {
            method: "PATCH",
            path: "/api/v1/me",
            body: { embedModel: "voyage/voyage-4-lite", embedDimensions: null },
          },
        ],
      );
      expect(plain.seen[0]!.body).toEqual({
        embedModel: "voyage/voyage-4-lite",
      });
      const inUse = await runRf(
        ["config", "set", "embed-model", "x/y"],
        [
          {
            method: "PATCH",
            path: "/api/v1/me",
            status: 409,
            body: { error: "embed_model_in_use" },
          },
        ],
      );
      expect(inUse.exitCode).toBe(1);
    });

    test("names the project's collection and agent in rf.json, after checking they exist", async () => {
      const collection = await runRf(
        ["config", "set", "collection", "col_2"],
        [
          {
            path: "/api/v1/collections",
            body: {
              collections: [
                col("col_1", "default", true),
                col("col_2", "work"),
              ],
            },
          },
        ],
      );
      expect(collection.out).toBe(
        `${join(env.cwd, "rf.json")} now names collection col_2 (work).`,
      );
      const agentSet = await runRf(
        ["config", "set", "agent", "agent_1"],
        [
          {
            path: "/api/v1/agents",
            body: { agents: [agent("agent_1", "claude-code")] },
          },
        ],
      );
      expect(agentSet.out).toContain("now names agent agent_1 (claude-code).");
      expect(agentSet.out).toContain("No key is stored for it yet");
      // Both landed in the same file.
      expect(
        JSON.parse(await readFile(join(env.cwd, "rf.json"), "utf8")),
      ).toEqual({ collectionId: "col_2", agentId: "agent_1" });
      const unknown = await runRf(
        ["config", "set", "collection", "col_9"],
        [{ path: "/api/v1/collections", body: { collections: [] } }],
      );
      expect(unknown.exitCode).toBe(1);
      await expect(stat(join(env.cwd, "nope"))).rejects.toThrow();
    });

    test("shows what commands here run with", async () => {
      const { out } = await runRf(["config", "show"], []);
      expect(out).toBe(
        [
          "api         https://api.example.com",
          `key         ${KEY.slice(0, 11)}… (env)`,
          "profile     default",
          "collection  -",
          "agent       -",
        ].join("\n"),
      );
    });
  });

  describe("rf account delete", () => {
    test("refuses without the email typed back, then deletes and forgets the login", async () => {
      const refused = await runRf(
        ["account", "delete"],
        [{ path: "/api/v1/me", body: me }],
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.err).toContain(
        "rf account delete --confirm eddie@example.com",
      );
      expect(requests(refused.seen)).toEqual(["GET /api/v1/me"]);

      const wrong = await runRf(
        ["account", "delete", "--confirm", "someone@else.com"],
        [{ path: "/api/v1/me", body: me }],
      );
      expect(wrong.exitCode).toBe(1);

      const gone = await runRf(
        ["account", "delete", "--confirm", "eddie@example.com"],
        [
          { path: "/api/v1/me", body: me },
          {
            method: "DELETE",
            path: "/api/v1/me",
            body: { id: "user_1", deletedAt: "2026-10-19T00:00:00.000Z" },
          },
        ],
      );
      expect(requests(gone.seen)).toEqual([
        "GET /api/v1/me",
        "DELETE /api/v1/me",
      ]);
      expect(gone.out).toContain("Deleted the account eddie@example.com.");
    });
  });

  describe("in a project that acts as an agent", () => {
    const LOGIN = "rf_" + "l".repeat(43);
    const AGENT = "rf_" + "a".repeat(43);
    const keysList: Canned = { path: "/api/v1/keys", body: { keys: [] } };
    const forbidden: Canned = {
      path: "/api/v1/keys",
      status: 403,
      body: { error: "forbidden" },
    };
    const bearer = (seen: Array<{ headers: Record<string, string> }>) =>
      seen[0]!.headers.authorization;

    beforeEach(async () => {
      delete process.env.RF_API_KEY;
      await mkdir(dirname(env.credentialsFile), { recursive: true });
      await writeFile(
        env.credentialsFile,
        JSON.stringify({
          profiles: {
            default: {
              apiUrl: "https://api.example.com",
              apiKey: LOGIN,
              keyPrefix: LOGIN.slice(0, 11),
              userId: "user_1",
              email: "eddie@example.com",
              defaultCollectionId: "col_1",
            },
          },
          agents: {
            agent_1: { apiKey: AGENT, keyPrefix: AGENT.slice(0, 11) },
          },
        }),
      );
      await writeFile(
        join(env.cwd, "rf.json"),
        JSON.stringify({ agentId: "agent_1" }),
      );
    });

    test("lets the person manage the account with their own login", async () => {
      const { exitCode, seen } = await runRf(["keys", "list"], [keysList]);
      expect(exitCode).toBeUndefined();
      expect(bearer(seen)).toBe(`Bearer ${LOGIN}`);
      const shown = await runRf(["config", "show"], []);
      expect(shown.out).toContain("(profile)");
      expect(shown.out).toContain("agent_1 (when an agent runs rf here)");
    });

    test("keeps Claude Code to the agent, and says why it was refused without a way round", async () => {
      process.env.CLAUDECODE = "1";
      const { err, exitCode, seen } = await runRf(
        ["keys", "list"],
        [forbidden],
      );
      expect(bearer(seen)).toBe(`Bearer ${AGENT}`);
      expect(exitCode).toBe(1);
      expect(err).toBe(
        `The api refused the request (forbidden, HTTP 403). rf used the key of agent agent_1, which ${join(env.cwd, "rf.json")} names, because Claude Code ran it; that agent may not do this. It takes your own login, from a terminal of your own.`,
      );
      expect(err).not.toMatch(/RF_AGENT|CLAUDECODE|cd /);
      const shown = await runRf(["config", "show"], []);
      expect(shown.out).toContain("(agent, as Claude Code ran it)");
      expect(shown.out).toContain("agent_1 (acting as it)");
    });

    test("acts as the agent with RF_AGENT=1, for agents other than Claude Code", async () => {
      process.env.RF_AGENT = "1";
      const { err, seen } = await runRf(["keys", "list"], [forbidden]);
      expect(bearer(seen)).toBe(`Bearer ${AGENT}`);
      expect(err).toContain("because RF_AGENT is set");
    });

    test("says a key from RF_API_KEY may be an agent's when it is refused", async () => {
      process.env.RF_API_KEY = AGENT;
      const { err } = await runRf(["keys", "list"], [forbidden]);
      expect(err).toBe(
        "The api refused the request (forbidden, HTTP 403). The key in RF_API_KEY may be an agent's, which may not do this; `rf whoami` says whose it is.",
      );
    });
  });
});
