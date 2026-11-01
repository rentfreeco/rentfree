import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isolatedEnvironment, runRf, type Canned } from "../test/fakes";

const KEY = "rf_" + "k".repeat(43);
const at = "2026-10-19T12:00:00.000Z";

const session = (
  id: string,
  externalId: string,
  endedAt: string | null = null,
) => ({
  id,
  collectionId: "col_1",
  agentId: null,
  externalId,
  title: null,
  startedAt: at,
  endedAt,
});

const page = <T>(items: T[]) => ({ items, nextCursor: null });

const pack = (text: string) => ({
  text,
  tokenCount: 10,
  tokenBudget: 2000,
  mode: "importance",
  profile: null,
  memories: [],
  chunks: [],
});

const stdin = (fields: object) =>
  JSON.stringify({
    session_id: "cc-123",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/p",
    ...fields,
  });

/** The api answering the session lookup every hook makes. */
const sessionLookup: Canned = {
  method: "POST",
  path: "/api/v1/sessions",
  status: 200,
  body: session("ses_1", "claude-code:cc-123"),
};

const requests = (seen: { method: string; url: string }[]) =>
  seen.map((s) => `${s.method} ${new URL(s.url).pathname}`);

describe("rf hooks", () => {
  const env = isolatedEnvironment();
  let homeBefore: string | undefined;
  beforeEach(async () => {
    await env.setup();
    // The user scope writes to ~/.claude; keep it in the temporary home.
    homeBefore = process.env.HOME;
    process.env.HOME = env.home;
    process.env.RF_API_KEY = KEY;
    process.env.RF_API_URL = "https://api.example.com";
    await writeFile(
      join(env.cwd, "rf.json"),
      JSON.stringify({ collectionId: "col_1" }),
    );
  });
  afterEach(async () => {
    process.env.HOME = homeBefore;
    await env.teardown();
  });

  const projectSettings = () => join(env.cwd, ".claude", "settings.json");

  describe("install, status, and uninstall", () => {
    test("install merges into the project's settings, and uninstall restores them", async () => {
      await mkdir(join(env.cwd, ".claude"));
      const theirs = {
        permissions: { allow: ["Bash(pnpm test)"] },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
        },
      };
      await writeFile(projectSettings(), JSON.stringify(theirs));

      const installed = await runRf(["hooks", "install", "--tools"], []);
      expect(installed.exitCode).toBeUndefined();
      expect(installed.out).toContain("Installed 5 hooks in");
      const written = JSON.parse(await readFile(projectSettings(), "utf8"));
      expect(written.permissions).toEqual(theirs.permissions);
      expect(written.hooks.Stop).toHaveLength(2);
      expect(Object.keys(written.hooks).sort()).toEqual(
        [
          "PostToolUse",
          "SessionEnd",
          "SessionStart",
          "Stop",
          "UserPromptSubmit",
        ].sort(),
      );

      const status = await runRf(["hooks", "status"], []);
      expect(status.out.split("\n")[0]).toBe(
        "scope    event             command",
      );
      expect(status.out).toContain(
        "project  PostToolUse       rf hooks run tool",
      );

      const removed = await runRf(["hooks", "uninstall"], []);
      expect(removed.out).toContain("Removed 5 rentfree hooks");
      expect(JSON.parse(await readFile(projectSettings(), "utf8"))).toEqual(
        theirs,
      );
    });

    test("--scope local and user write their own files", async () => {
      await runRf(["hooks", "install", "--scope", "local"], []);
      await runRf(["hooks", "install", "--scope", "user"], []);
      const local = JSON.parse(
        await readFile(join(env.cwd, ".claude", "settings.local.json"), "utf8"),
      );
      const user = JSON.parse(
        await readFile(join(env.home, ".claude", "settings.json"), "utf8"),
      );
      expect(Object.keys(local.hooks)).toHaveLength(4);
      expect(Object.keys(user.hooks)).toHaveLength(4);
    });

    test("leaves a settings file it cannot read alone", async () => {
      await mkdir(join(env.cwd, ".claude"));
      await writeFile(projectSettings(), "{ not json");
      const r = await runRf(["hooks", "install"], []);
      expect(r.err).toContain("is not a JSON object, so it is left alone");
      expect(r.exitCode).toBe(1);
      expect(await readFile(projectSettings(), "utf8")).toBe("{ not json");
    });
  });

  describe("run", () => {
    test("session-start prints the pack for Claude's context, and makes no session", async () => {
      const r = await runRf(
        ["hooks", "run", "session-start", "--budget", "900"],
        [
          {
            method: "POST",
            path: "/api/v1/context",
            body: pack("## Memories\n- Ships on Fridays."),
          },
        ],
        {
          stdin: stdin({ hook_event_name: "SessionStart", source: "startup" }),
        },
      );
      expect(requests(r.seen)).toEqual(["POST /api/v1/context"]);
      expect(r.seen[0]!.body).toEqual({
        collectionId: "col_1",
        tokenBudget: 900,
      });
      expect(r.out).toBe(
        "# From rentfree's memory\n\n## Memories\n- Ships on Fridays.",
      );
      expect(r.exitCode).toBeUndefined();
    });

    test("acts as the project's agent, though nothing in the environment says an agent runs it", async () => {
      delete process.env.RF_API_KEY;
      const AGENT = "rf_" + "a".repeat(43);
      await mkdir(dirname(env.credentialsFile), { recursive: true });
      await writeFile(
        env.credentialsFile,
        JSON.stringify({
          profiles: {
            default: {
              apiUrl: "https://api.example.com",
              apiKey: KEY,
              keyPrefix: KEY.slice(0, 11),
              userId: "user_1",
              email: "eddie@example.com",
              defaultCollectionId: "col_1",
            },
          },
          agents: { agent_1: { apiKey: AGENT, keyPrefix: AGENT.slice(0, 11) } },
        }),
      );
      await writeFile(
        join(env.cwd, "rf.json"),
        JSON.stringify({ collectionId: "col_1", agentId: "agent_1" }),
      );
      const r = await runRf(
        ["hooks", "run", "session-start"],
        [{ method: "POST", path: "/api/v1/context", body: pack("") }],
        { stdin: stdin({}) },
      );
      expect(r.seen[0]!.headers.authorization).toBe(`Bearer ${AGENT}`);
    });

    test("session-start adds nothing to the context for an empty pack", async () => {
      const r = await runRf(
        ["hooks", "run", "session-start"],
        [{ method: "POST", path: "/api/v1/context", body: pack("") }],
        { stdin: stdin({}) },
      );
      expect(r.out).toBe("");
    });

    test("prompt logs what the user asked, and with --recall prints a pack for it", async () => {
      const r = await runRf(
        ["hooks", "run", "prompt", "--recall"],
        [
          sessionLookup,
          {
            method: "POST",
            path: "/api/v1/sessions/ses_1/events",
            status: 201,
            body: { events: [] },
          },
          {
            method: "POST",
            path: "/api/v1/context",
            body: pack("- CI must be green."),
          },
        ],
        {
          stdin: stdin({
            hook_event_name: "UserPromptSubmit",
            prompt: "Can I deploy?",
          }),
        },
      );
      expect(r.seen[1]!.body).toEqual({
        events: [{ type: "message.user", content: "Can I deploy?" }],
      });
      expect(r.seen[2]!.body).toEqual({
        collectionId: "col_1",
        query: "Can I deploy?",
      });
      expect(r.out).toBe("# From rentfree's memory\n\n- CI must be green.");
    });

    test("prompt passes over the task notifications Claude Code sends as prompts, keeping what the user wrote", async () => {
      // As Claude Code sends one when a background command finishes.
      const notification = [
        "<task-notification>",
        "<task-id>b1</task-id>",
        "<tool-use-id>toolu_1</tool-use-id>",
        "<output-file>/tmp/tasks/b1.output</output-file>",
        "<status>completed</status>",
        '<summary>Background command "Run the tests" completed (exit code 0)</summary>',
        "</task-notification>",
      ].join("\n");
      const answers: Canned[] = [
        sessionLookup,
        {
          method: "POST",
          path: "/api/v1/sessions/ses_1/events",
          status: 201,
          body: { events: [] },
        },
        {
          method: "POST",
          path: "/api/v1/context",
          body: pack("- CI must be green."),
        },
      ];

      const only = await runRf(
        ["hooks", "run", "prompt", "--recall"],
        answers,
        {
          stdin: stdin({
            hook_event_name: "UserPromptSubmit",
            prompt: notification,
          }),
        },
      );
      expect(only.seen).toEqual([]);
      expect(only.out).toBe("");
      expect(only.exitCode).toBeUndefined();

      const mixed = await runRf(
        ["hooks", "run", "prompt", "--recall"],
        answers,
        {
          stdin: stdin({
            hook_event_name: "UserPromptSubmit",
            prompt: `${notification}\n${notification}\nNow ship it.`,
          }),
        },
      );
      expect(mixed.seen[1]!.body).toEqual({
        events: [{ type: "message.user", content: "Now ship it." }],
      });
      expect(mixed.seen[2]!.body).toEqual({
        collectionId: "col_1",
        query: "Now ship it.",
      });
    });

    test("stop logs the assistant's last message, unless a stop hook already continued", async () => {
      const answers: Canned[] = [
        sessionLookup,
        {
          method: "POST",
          path: "/api/v1/sessions/ses_1/events",
          status: 201,
          body: { events: [] },
        },
      ];
      const logged = await runRf(["hooks", "run", "stop"], answers, {
        stdin: stdin({ last_assistant_message: "Deployed." }),
      });
      expect(logged.seen[1]!.body).toEqual({
        events: [{ type: "message.assistant", content: "Deployed." }],
      });

      const skipped = await runRf(["hooks", "run", "stop"], answers, {
        stdin: stdin({
          last_assistant_message: "Again.",
          stop_hook_active: true,
        }),
      });
      expect(skipped.seen).toEqual([]);
    });

    test("session-end ends the session, which starts the recap", async () => {
      const r = await runRf(
        ["hooks", "run", "session-end"],
        [
          {
            method: "GET",
            path: "/api/v1/sessions",
            body: page([session("ses_1", "claude-code:cc-123")]),
          },
          {
            method: "PATCH",
            path: "/api/v1/sessions/ses_1",
            body: session("ses_1", "claude-code:cc-123", at),
          },
        ],
        { stdin: stdin({ hook_event_name: "SessionEnd", reason: "other" }) },
      );
      expect(requests(r.seen)).toEqual([
        "GET /api/v1/sessions",
        "PATCH /api/v1/sessions/ses_1",
      ]);
      const lookup = new URL(r.seen[0]!.url).searchParams;
      expect(lookup.get("externalId")).toBe("claude-code:cc-123");
      expect(lookup.get("collectionId")).toBe("col_1");
      expect(r.seen[1]!.body).toEqual({ ended: true });
    });

    test("session-end makes no session for a Claude Code session that logged nothing", async () => {
      // Claude Code ends sessions whose start no hook saw, such as a forked one.
      const r = await runRf(
        ["hooks", "run", "session-end"],
        [{ method: "GET", path: "/api/v1/sessions", body: page([]) }],
        { stdin: stdin({ hook_event_name: "SessionEnd", reason: "other" }) },
      );
      expect(requests(r.seen)).toEqual(["GET /api/v1/sessions"]);
      expect(r.exitCode).toBeUndefined();
    });

    test("session-end ends the open continuation of a resumed session, and never another session", async () => {
      const r = await runRf(
        ["hooks", "run", "session-end"],
        [
          {
            method: "GET",
            path: "/api/v1/sessions",
            respond: (call) => ({
              body: page(
                call === 0
                  ? [session("ses_1", "claude-code:cc-123", at)]
                  : [session("ses_2", "claude-code:cc-123:2")],
              ),
            }),
          },
          {
            method: "PATCH",
            path: "/api/v1/sessions/ses_2",
            body: session("ses_2", "claude-code:cc-123:2", at),
          },
        ],
        { stdin: stdin({}) },
      );
      expect(requests(r.seen)).toEqual([
        "GET /api/v1/sessions",
        "GET /api/v1/sessions",
        "PATCH /api/v1/sessions/ses_2",
      ]);

      // An api that ignores the filter answers with some other session.
      const unfiltered = await runRf(
        ["hooks", "run", "session-end"],
        [
          {
            method: "GET",
            path: "/api/v1/sessions",
            body: page([session("ses_9", "claude-code:someone-else")]),
          },
        ],
        { stdin: stdin({}) },
      );
      expect(requests(unfiltered.seen)).toEqual(["GET /api/v1/sessions"]);
    });

    test("tool logs the call and the result, cut to 4 KB each", async () => {
      const r = await runRf(
        ["hooks", "run", "tool"],
        [
          sessionLookup,
          {
            method: "POST",
            path: "/api/v1/sessions/ses_1/events",
            status: 201,
            body: { events: [] },
          },
        ],
        {
          stdin: stdin({
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
            tool_response: "x".repeat(10_000),
          }),
        },
      );
      const events = (
        r.seen[1]!.body as {
          events: Array<{ type: string; content: string; metadata: object }>;
        }
      ).events;
      expect(events.map((e) => e.type)).toEqual(["tool.call", "tool.result"]);
      expect(events[0]!.content).toBe('{"command":"pnpm test"}');
      expect(events[1]!.content).toHaveLength(4096);
      expect(events[1]!.metadata).toEqual({ tool: "Bash" });
    });

    test("a session resumed after it ended continues in a new one", async () => {
      const r = await runRf(
        ["hooks", "run", "prompt"],
        [
          {
            method: "POST",
            path: "/api/v1/sessions",
            respond: (call) =>
              call === 0
                ? {
                    status: 200,
                    body: session("ses_1", "claude-code:cc-123", at),
                  }
                : {
                    status: 201,
                    body: session("ses_2", "claude-code:cc-123:2"),
                  },
          },
          {
            method: "POST",
            path: "/api/v1/sessions/ses_2/events",
            status: 201,
            body: { events: [] },
          },
        ],
        { stdin: stdin({ prompt: "Back again." }) },
      );
      expect(
        r.seen
          .map((s) => (s.body as { externalId?: string })?.externalId)
          .slice(0, 2),
      ).toEqual(["claude-code:cc-123", "claude-code:cc-123:2"]);
      expect(requests(r.seen)[2]).toBe("POST /api/v1/sessions/ses_2/events");
    });

    test("never fails the session: one line on stderr, nothing on stdout, exit 0", async () => {
      const notJson = await runRf(["hooks", "run", "prompt"], [], {
        stdin: "garbage",
      });
      expect(notJson.err).toBe(
        "rf hooks prompt: stdin is not the JSON Claude Code sends a hook",
      );
      expect(notJson.exitCode).toBeUndefined();

      const refused = await runRf(
        ["hooks", "run", "session-start"],
        [
          {
            method: "POST",
            path: "/api/v1/context",
            status: 500,
            body: { error: "internal" },
          },
        ],
        { stdin: stdin({}) },
      );
      expect(refused.out).toBe("");
      expect(refused.err).toBe(
        "rf hooks session-start: The api refused the request (internal, HTTP 500).",
      );
      expect(refused.exitCode).toBeUndefined();

      delete process.env.RF_API_KEY;
      const loggedOut = await runRf(["hooks", "run", "stop"], [], {
        stdin: stdin({ last_assistant_message: "x" }),
      });
      expect(loggedOut.err).toBe("rf hooks stop: not logged in; run `rf init`");
      expect(loggedOut.exitCode).toBeUndefined();
      expect(loggedOut.seen).toEqual([]);
    });

    test("is not listed in help", async () => {
      const help = await runRf(["hooks", "--help"], []);
      expect(help.out).toContain("install");
      expect(help.out).not.toMatch(/^\s+run\s/m);
    });
  });
});
