import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isolatedEnvironment, runRf, type Canned } from "../test/fakes";

const KEY = "rf_" + "k".repeat(43);
const at = "2026-10-19T12:00:00.000Z";

const me = {
  user: { id: "user_1", email: null, embedModel: "m", embedDimensions: null },
  caller: {
    agentId: null,
    apiKeyId: "key_1",
    keyPrefix: "rf_kkkkkkkk",
    keyName: null,
  },
  collections: [
    {
      id: "col_1",
      name: "default",
      isDefault: true,
      createdAt: at,
      archivedAt: null,
    },
  ],
};

const memory = (id: string, content: string, over: object = {}) => ({
  id,
  collectionId: "col_1",
  type: "fact",
  tier: "long",
  origin: "agent",
  status: "active",
  subject: null,
  content,
  confidence: 1,
  importance: 0.5,
  importanceNow: 0.42,
  version: 1,
  validFrom: at,
  validTo: null,
  supersedesId: null,
  accessCount: 0,
  lastAccessedAt: null,
  createdAt: at,
  updatedAt: at,
  expiresAt: null,
  ...over,
});

const pack = (text: string) => ({
  text,
  tokenCount: 12,
  tokenBudget: 2000,
  mode: "importance",
  profile: null,
  memories: [],
  chunks: [],
});

const requests = (seen: { method: string; url: string }[]) =>
  seen.map(
    (s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`,
  );

describe("recall and memory commands", () => {
  const env = isolatedEnvironment();
  beforeEach(async () => {
    await env.setup();
    process.env.RF_API_KEY = KEY;
    process.env.RF_API_URL = "https://api.example.com";
  });
  afterEach(() => env.teardown());

  describe("rf context", () => {
    test("prints the pack's text and nothing else", async () => {
      const run = await runRf(
        [
          "context",
          "what ships on friday?",
          "--collection",
          "col_9",
          "--budget",
          "500",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/context",
            body: pack("## Memories\n- Ships on Fridays."),
          },
        ],
      );
      expect(run.out).toBe("## Memories\n- Ships on Fridays.");
      expect(run.seen[0]!.body).toEqual({
        collectionId: "col_9",
        query: "what ships on friday?",
        tokenBudget: 500,
      });
      // A read sent as POST carries no idempotency key.
      expect(run.seen[0]!.headers["idempotency-key"]).toBeUndefined();
    });

    test("prints nothing for an empty pack, so a hook adds nothing", async () => {
      const run = await runRf(
        ["context"],
        [
          { path: "/api/v1/me", body: me },
          { method: "POST", path: "/api/v1/context", body: pack("") },
        ],
      );
      expect(run.out).toBe("");
      expect(run.exitCode).toBeUndefined();
    });

    test("prints the whole pack with --json", async () => {
      const run = await runRf(
        ["context", "--json", "--collection", "col_1"],
        [{ method: "POST", path: "/api/v1/context", body: pack("x") }],
      );
      expect(JSON.parse(run.out)).toMatchObject({ text: "x", tokenCount: 12 });
    });
  });

  describe("which collection a command uses", () => {
    test("the flag, then rf.json, then the account's default", async () => {
      const answers: Canned[] = [
        { path: "/api/v1/me", body: me },
        { method: "POST", path: "/api/v1/context", body: pack("x") },
      ];
      const fromDefault = await runRf(["context"], answers);
      expect(requests(fromDefault.seen)).toEqual([
        "GET /api/v1/me",
        "POST /api/v1/context",
      ]);
      expect(fromDefault.seen[1]!.body).toMatchObject({
        collectionId: "col_1",
      });

      await writeFile(
        join(env.cwd, "rf.json"),
        JSON.stringify({ collectionId: "col_project" }),
      );
      const fromProject = await runRf(["context"], answers);
      expect(requests(fromProject.seen)).toEqual(["POST /api/v1/context"]);
      expect(fromProject.seen[0]!.body).toMatchObject({
        collectionId: "col_project",
      });

      const fromFlag = await runRf(
        ["context", "--collection", "col_flag"],
        answers,
      );
      expect(fromFlag.seen[0]!.body).toMatchObject({
        collectionId: "col_flag",
      });
    });

    test("says what to do when there is none", async () => {
      const run = await runRf(
        ["context"],
        [{ path: "/api/v1/me", body: { ...me, collections: [] } }],
      );
      expect(run.err).toBe(
        "No collection to use. Pass --collection, or run `rf config set collection <id>`.",
      );
      expect(run.exitCode).toBe(1);
    });
  });

  describe("rf search", () => {
    test("prints one line per hit, and searches every collection by default", async () => {
      const run = await runRf(
        ["search", "fridays", "--kind", "memory", "--tier", "long,working"],
        [
          {
            method: "POST",
            path: "/api/v1/search",
            body: {
              mode: "hybrid",
              memories: [
                {
                  ...memory("mem_1", "The team\nships on Fridays."),
                  subject: "release",
                  score: 0.0331,
                  vectorRank: 1,
                  textRank: 2,
                },
              ],
              chunks: [
                {
                  id: "chk_1",
                  text: "Releases go out every Friday.",
                  headingPath: "Process",
                  source: {
                    id: "src_1",
                    title: "Handbook",
                    uri: null,
                    collectionId: "col_1",
                  },
                  score: 0.0298,
                  vectorRank: 2,
                  textRank: null,
                },
              ],
            },
          },
        ],
      );
      expect(run.seen[0]!.body).toEqual({
        query: "fridays",
        limit: 10,
        kinds: ["memory"],
        tiers: ["long", "working"],
      });
      expect(run.out.split("\n")).toEqual([
        "kind    id     score   text",
        "memory  mem_1  0.0331  release: The team ships on Fridays.",
        "chunk   chk_1  0.0298  Handbook › Process: Releases go out every Friday.",
      ]);
    });

    test("says when nothing was found", async () => {
      const run = await runRf(
        ["search", "nothing"],
        [
          {
            method: "POST",
            path: "/api/v1/search",
            body: { mode: "hybrid", memories: [], chunks: [] },
          },
        ],
      );
      expect(run.out).toBe("Nothing found.");
    });
  });

  describe("rf remember", () => {
    test("writes a long-term fact by default, and prints its id", async () => {
      const run = await runRf(
        ["remember", "Deploys need a green CI.", "--collection", "col_1"],
        [
          {
            method: "POST",
            path: "/api/v1/memories",
            status: 201,
            body: memory("mem_7", "Deploys need a green CI."),
          },
        ],
      );
      expect(run.out).toBe("Remembered mem_7.");
      expect(run.seen[0]!.body).toEqual({
        collectionId: "col_1",
        content: "Deploys need a green CI.",
        type: "fact",
        tier: "long",
      });
      expect(run.seen[0]!.headers["idempotency-key"]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    test("reads the content from stdin with -, and passes every option", async () => {
      const run = await runRf(
        [
          "remember",
          "-",
          "--collection",
          "col_1",
          "--type",
          "decision",
          "--tier",
          "working",
          "--subject",
          "release",
          "--importance",
          "0.9",
          "--expires",
          "2026-10-25T00:00:00Z",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/memories",
            status: 201,
            body: memory("mem_8", "x"),
          },
        ],
        { stdin: "Freeze merges on Thursday.\n" },
      );
      expect(run.seen[0]!.body).toEqual({
        collectionId: "col_1",
        content: "Freeze merges on Thursday.",
        type: "decision",
        tier: "working",
        subject: "release",
        importance: 0.9,
        expiresAt: "2026-10-25T00:00:00Z",
      });
    });

    test("explains the api's refusal in one line", async () => {
      const run = await runRf(
        [
          "remember",
          "x",
          "--collection",
          "col_1",
          "--tier",
          "working",
          "--expires",
          "2020-01-01T00:00:00Z",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/memories",
            status: 400,
            body: {
              error: "invalid_request",
              issues: [{ path: "expiresAt", message: "Must be in the future" }],
            },
          },
        ],
      );
      expect(run.err).toBe(
        "The api refused the request (invalid_request): expiresAt: Must be in the future",
      );
      expect(run.exitCode).toBe(1);
    });
  });

  describe("rf memories", () => {
    test("lists memories with their importance today", async () => {
      const run = await runRf(
        ["memories", "list", "--collection", "col_1", "--limit", "1"],
        [
          {
            path: "/api/v1/memories",
            body: {
              items: [memory("mem_1", "Ships on Fridays.")],
              nextCursor: "c1",
            },
          },
        ],
      );
      expect(requests(run.seen)).toEqual([
        "GET /api/v1/memories?collectionId=col_1&status=active&limit=1",
      ]);
      expect(run.out.split("\n")).toEqual([
        "id     type  tier  importance  content",
        "mem_1  fact  long  0.42        Ships on Fridays.",
        "(more; raise --limit to see them)",
      ]);
    });

    test("edits, archives, and restores", async () => {
      const answers: Canned[] = [
        {
          method: "PATCH",
          path: "/api/v1/memories/mem_1",
          body: memory("mem_1", "new", { version: 2 }),
        },
        {
          method: "DELETE",
          path: "/api/v1/memories/mem_1",
          body: memory("mem_1", "new", { status: "archived" }),
        },
      ];
      const edited = await runRf(
        [
          "memories",
          "edit",
          "mem_1",
          "--content",
          "new",
          "--importance",
          "0.8",
        ],
        answers,
      );
      expect(edited.out).toBe("Updated mem_1, now version 2.");
      expect(edited.seen[0]!.body).toEqual({ content: "new", importance: 0.8 });

      const archived = await runRf(["memories", "archive", "mem_1"], answers);
      expect(archived.out).toBe("Archived mem_1.");

      const restored = await runRf(["memories", "restore", "mem_1"], answers);
      expect(restored.seen[0]!.body).toEqual({ status: "active" });
      expect(restored.out).toBe("Restored mem_1.");
    });

    test("refuses an edit with nothing to change, without asking the api", async () => {
      const run = await runRf(["memories", "edit", "mem_1"], []);
      expect(run.err).toBe(
        "Nothing to change; pass --content, --subject, or --importance.",
      );
      expect(run.exitCode).toBe(1);
      expect(run.seen).toEqual([]);
    });

    test("shows where a memory came from", async () => {
      const run = await runRf(
        ["memories", "sources", "mem_1"],
        [
          {
            path: "/api/v1/memories/mem_1/sources",
            body: {
              items: [
                {
                  sourceId: null,
                  chunkId: null,
                  eventId: 42,
                  sessionId: "ses_1",
                  quote: "we ship on Fridays",
                  createdAt: at,
                },
              ],
            },
          },
        ],
      );
      expect(run.out.split("\n")).toEqual([
        "from                    quote",
        "session ses_1 event 42  we ship on Fridays",
      ]);
    });
  });

  describe("rf profile", () => {
    test("prints the profile, and a note rather than a failure when there is none yet", async () => {
      const found = await runRf(
        ["profile", "--collection", "col_1"],
        [
          {
            path: "/api/v1/collections/col_1/profile",
            body: {
              collectionId: "col_1",
              version: 3,
              content: "A team that ships on Fridays.",
              tokenCount: 7,
              generatedAt: at,
            },
          },
        ],
      );
      expect(found.out).toBe("A team that ships on Fridays.");

      const none = await runRf(
        ["profile", "--collection", "col_2"],
        [
          {
            path: "/api/v1/collections/col_2/profile",
            status: 404,
            body: { error: "not_found" },
          },
        ],
      );
      expect(none.out).toBe("");
      expect(none.err).toContain("No profile for col_2 yet.");
      expect(none.exitCode).toBeUndefined();
    });
  });
});
