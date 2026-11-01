import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isolatedEnvironment, runRf, type Canned } from "../test/fakes";

const KEY = "rf_" + "k".repeat(43);
const at = "2026-10-19T12:00:00.000Z";

const session = (over: object = {}) => ({
  id: "ses_1",
  collectionId: "col_1",
  agentId: null,
  externalId: null,
  title: null,
  startedAt: at,
  endedAt: null,
  ...over,
});

const event = (id: number, type: string, content: string) => ({
  id,
  sessionId: "ses_1",
  agentId: null,
  type,
  content,
  metadata: {},
  createdAt: at,
});

const source = (over: object = {}) => ({
  id: "src_1",
  collectionId: "col_1",
  kind: "text",
  status: "ready",
  title: "notes.md",
  uri: null,
  externalId: null,
  format: "markdown",
  metadata: {},
  error: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
  ...over,
});

const run = (over: object = {}) => ({
  id: "run_1",
  trigger: "manual",
  status: "succeeded",
  eventsFromId: 10,
  eventsToId: 24,
  extractModel: "m",
  reconcileModel: "m",
  inputTokens: 1200,
  outputTokens: 300,
  costUsd: 0.0021,
  stats: { created: 2, updated: 1, confirmed: 0 },
  error: null,
  startedAt: at,
  finishedAt: at,
  ...over,
});

const requests = (seen: { method: string; url: string }[]) =>
  seen.map(
    (s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`,
  );

describe("capture commands", () => {
  const env = isolatedEnvironment();
  beforeEach(async () => {
    await env.setup();
    process.env.RF_API_KEY = KEY;
    process.env.RF_API_URL = "https://api.example.com";
  });
  afterEach(() => env.teardown());

  describe("rf session", () => {
    test("start prints only the id, so a script can capture it", async () => {
      const r = await runRf(
        [
          "session",
          "start",
          "--collection",
          "col_1",
          "--title",
          "Fix CI",
          "--external-id",
          "cc:1",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/sessions",
            status: 201,
            body: session(),
          },
        ],
      );
      expect(r.out).toBe("ses_1");
      expect(r.seen[0]!.body).toEqual({
        collectionId: "col_1",
        title: "Fix CI",
        externalId: "cc:1",
      });
    });

    test("end marks it ended, with a title", async () => {
      const r = await runRf(
        ["session", "end", "ses_1", "--title", "Fixed CI"],
        [
          {
            method: "PATCH",
            path: "/api/v1/sessions/ses_1",
            body: session({ endedAt: at }),
          },
        ],
      );
      expect(r.seen[0]!.body).toEqual({ ended: true, title: "Fixed CI" });
      expect(r.out).toBe(
        "Ended ses_1. A recap of anything not yet read starts on its own.",
      );
    });

    test("events lists a session's events on one line each", async () => {
      const r = await runRf(
        ["session", "events", "ses_1"],
        [
          {
            path: "/api/v1/sessions/ses_1/events",
            body: {
              items: [event(1, "message.user", "Why is CI\nred?")],
              nextCursor: null,
            },
          },
        ],
      );
      expect(requests(r.seen)).toEqual([
        "GET /api/v1/sessions/ses_1/events?limit=50",
      ]);
      expect(r.out.split("\n")).toEqual([
        "id  type          content",
        "1   message.user  Why is CI red?",
      ]);
    });
  });

  describe("rf log", () => {
    test("logs one event from stdin, with metadata", async () => {
      const r = await runRf(
        [
          "log",
          "ses_1",
          "--type",
          "message.user",
          "--meta",
          "tool=claude-code",
          "--meta",
          "turn=3",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/sessions/ses_1/events",
            status: 201,
            body: { events: [event(7, "message.user", "hi")] },
          },
        ],
        { stdin: "Why is CI red?\n" },
      );
      expect(r.seen[0]!.body).toEqual({
        events: [
          {
            type: "message.user",
            content: "Why is CI red?",
            metadata: { tool: "claude-code", turn: "3" },
          },
        ],
      });
      expect(r.out).toBe("Logged event 7.");
    });

    test("sends --batch input 100 events to a request", async () => {
      const lines = Array.from({ length: 150 }, (_, i) =>
        JSON.stringify({ type: "note", content: `step ${i}` }),
      ).join("\n");
      const r = await runRf(
        ["log", "ses_1", "--batch"],
        [
          {
            method: "POST",
            path: "/api/v1/sessions/ses_1/events",
            status: 201,
            respond: (call) => ({
              body: {
                events: Array.from({ length: call === 0 ? 100 : 50 }, (_, i) =>
                  event(call * 100 + i + 1, "note", "x"),
                ),
              },
            }),
          },
        ],
        { stdin: lines },
      );
      expect(
        r.seen.map((s) => (s.body as { events: unknown[] }).events.length),
      ).toEqual([100, 50]);
      expect(r.out).toBe("Logged 150 events.");
    });

    test("names the line --batch cannot read, and sends nothing", async () => {
      const r = await runRf(["log", "ses_1", "--batch"], [], {
        stdin:
          '{"type":"note","content":"ok"}\n{"type":"chat","content":"no"}\n',
      });
      expect(r.err).toBe(
        "Line 2 needs a type (message.user, message.assistant, tool.call, tool.result, note) and a content.",
      );
      expect(r.exitCode).toBe(1);
      expect(r.seen).toEqual([]);
    });

    test("asks for a type without --batch", async () => {
      const r = await runRf(["log", "ses_1", "--content", "x"], []);
      expect(r.err).toBe("Pass --type, or --batch with JSON lines on stdin.");
      expect(r.exitCode).toBe(1);
    });
  });

  describe("rf sources add", () => {
    test("sends a markdown file inline, named by its full path", async () => {
      await writeFile(join(env.cwd, "notes.md"), "# Notes\n\nShip on Fridays.");
      const answers: Canned[] = [
        {
          method: "POST",
          path: "/api/v1/sources",
          respond: (call) =>
            call === 0
              ? { status: 201, body: source() }
              : { status: 200, body: source() },
        },
      ];
      const first = await runRf(
        ["sources", "add", "notes.md", "--collection", "col_1"],
        answers,
      );
      expect(first.seen[0]!.body).toEqual({
        kind: "text",
        content: "# Notes\n\nShip on Fridays.",
        format: "markdown",
        title: "notes.md",
        collectionId: "col_1",
        externalId: `file:${join(env.cwd, "notes.md")}`,
      });
      expect(first.out).toBe("Added src_1: notes.md, version 1, ready.");

      // Each run has its own fake; the api answers 200 for a name it has.
      const again = await runRf(
        ["sources", "add", "notes.md", "--collection", "col_1"],
        [
          {
            method: "POST",
            path: "/api/v1/sources",
            status: 200,
            body: source(),
          },
        ],
      );
      expect(again.out).toBe("Already had src_1: notes.md, version 1, ready.");
    });

    test("notes a source in the collection that already held the same text", async () => {
      await writeFile(join(env.cwd, "copy.md"), "# Notes\n\nShip on Fridays.");
      const duplicateOf = {
        id: "src_0",
        externalId: "file:/elsewhere/notes.md",
        title: "notes.md",
      };
      const answers: Canned[] = [
        {
          method: "POST",
          path: "/api/v1/sources",
          status: 201,
          body: { ...source({ title: "copy.md" }), duplicateOf },
        },
      ];
      const r = await runRf(
        ["sources", "add", "copy.md", "--collection", "col_1"],
        answers,
      );
      expect(r.out).toBe(
        "Added src_1: copy.md, version 1, ready.\nSame text as src_0: notes.md. Both are kept.",
      );

      const json = await runRf(
        ["sources", "add", "copy.md", "--collection", "col_1", "--json"],
        answers,
      );
      expect(JSON.parse(json.out)).toMatchObject({ id: "src_1", duplicateOf });
    });

    test("names a URL by itself, and waits for it with --wait", async () => {
      const url = "https://example.com/guide";
      const r = await runRf(
        ["sources", "add", url, "--collection", "col_1", "--wait"],
        [
          {
            method: "POST",
            path: "/api/v1/sources",
            status: 202,
            body: source({
              kind: "url",
              status: "pending",
              uri: url,
              title: null,
            }),
          },
          {
            path: "/api/v1/sources/src_1",
            respond: (call) => ({
              body: source({
                kind: "url",
                uri: url,
                title: "Guide",
                status: call === 0 ? "processing" : "ready",
                version: 1,
              }),
            }),
          },
        ],
      );
      expect(r.seen[0]!.body).toEqual({
        kind: "url",
        url,
        collectionId: "col_1",
        externalId: url,
      });
      expect(requests(r.seen)).toEqual([
        "POST /api/v1/sources",
        "GET /api/v1/sources/src_1",
        "GET /api/v1/sources/src_1",
      ]);
      expect(r.slept.length).toBe(1);
      expect(r.out).toBe("Queued src_1: Guide, version 1, ready.");
    });

    test("uploads a PDF: an upload URL, the bytes without the key, then the source", async () => {
      await writeFile(
        join(env.cwd, "report.pdf"),
        Buffer.from("%PDF-1.4 fake"),
      );
      const r = await runRf(
        ["sources", "add", "report.pdf", "--collection", "col_1"],
        [
          {
            method: "POST",
            path: "/api/v1/uploads",
            status: 201,
            body: {
              blobKey: "uploads/u/k/report.pdf",
              uploadUrl: "https://blob.example.com/put/abc",
              method: "PUT",
              headers: { "content-type": "application/pdf" },
              expiresAt: at,
            },
          },
          { method: "PUT", path: "/put/abc", status: 200 },
          {
            method: "POST",
            path: "/api/v1/sources",
            status: 202,
            body: source({
              kind: "file",
              status: "pending",
              title: "report.pdf",
            }),
          },
        ],
      );
      expect(r.seen[0]!.body).toEqual({
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
      });
      expect(r.seen[1]!.url).toBe("https://blob.example.com/put/abc");
      expect(r.seen[1]!.headers.authorization).toBeUndefined();
      expect(r.seen[2]!.body).toEqual({
        kind: "file",
        blobKey: "uploads/u/k/report.pdf",
        title: "report.pdf",
        collectionId: "col_1",
        externalId: `file:${join(env.cwd, "report.pdf")}`,
      });
      expect(r.out).toBe("Queued src_1: report.pdf, version 1, pending.");
    });

    test("refuses a file type it cannot read, and a file that is not there", async () => {
      await writeFile(join(env.cwd, "photo.png"), Buffer.from([1, 2, 3]));
      const png = await runRf(
        ["sources", "add", "photo.png", "--collection", "col_1"],
        [],
      );
      expect(png.err).toBe(
        "Cannot add photo.png: rentfree reads .pdf, .md, .markdown, .mdx, .txt, .text files.",
      );
      expect(png.exitCode).toBe(1);

      const missing = await runRf(
        ["sources", "add", "nope.md", "--collection", "col_1"],
        [],
      );
      expect(missing.err).toBe(`No file at ${join(env.cwd, "nope.md")}.`);
      expect(missing.seen).toEqual([]);
    });

    test("reports a source that failed, and exits 1", async () => {
      const r = await runRf(
        [
          "sources",
          "add",
          "https://example.com/gone",
          "--collection",
          "col_1",
          "--wait",
        ],
        [
          {
            method: "POST",
            path: "/api/v1/sources",
            status: 202,
            body: source({ kind: "url", status: "pending" }),
          },
          {
            path: "/api/v1/sources/src_1",
            body: source({ kind: "url", status: "failed", error: "HTTP 404" }),
          },
        ],
      );
      expect(r.err).toBe("src_1 failed: HTTP 404");
      expect(r.exitCode).toBe(1);
    });
  });

  describe("rf recap", () => {
    test("run says what it started", async () => {
      const r = await runRf(
        ["recap", "run"],
        [
          {
            method: "POST",
            path: "/api/v1/recap/run",
            status: 202,
            body: { status: "started", unread: 14 },
          },
        ],
      );
      expect(r.out).toBe("Started a recap of 14 unread events.");
      expect(r.seen[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("run --wait prints what the run decided and what it cost", async () => {
      const r = await runRf(
        ["recap", "run", "--wait"],
        [
          {
            path: "/api/v1/recap/runs",
            respond: (call) => ({
              body: {
                runs:
                  call === 0
                    ? [run({ id: "old" })]
                    : call === 1
                      ? [run({ status: "running", finishedAt: null })]
                      : [run()],
              },
            }),
          },
          {
            method: "POST",
            path: "/api/v1/recap/run",
            status: 202,
            body: { status: "started", unread: 14 },
          },
        ],
      );
      expect(r.out).toBe(
        "Recap run_1 succeeded: 2 created, 1 updated; events 11 to 24; $0.0021.",
      );
    });

    test("runs lists recent runs", async () => {
      const r = await runRf(
        ["recap", "runs", "--limit", "5"],
        [{ path: "/api/v1/recap/runs", body: { runs: [run()] } }],
      );
      expect(requests(r.seen)).toEqual(["GET /api/v1/recap/runs?limit=5"]);
      expect(r.out.split("\n")[1]).toBe(
        `run_1  manual   succeeded  2 created, 1 updated  $0.0021  ${at}`,
      );
    });
  });
});
