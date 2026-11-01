import type { Client } from "@rentfree/sdk";
import { Cause, Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { delimiter } from "node:path";
import { describeFailure, type Api, type ApiFailure } from "../client";
import type { Environment, Settings } from "../config";
import {
  HOOK_EVENTS,
  rentfreeHooks,
  withRentfree,
  withoutRentfree,
  type ClaudeSettings,
} from "../hooks";
import { print, table } from "../output";
import { Platform } from "../platform";
import { agentSession, session } from "./shared";

/** Event content is capped by the api; tool input and output are cut much shorter. */
const MESSAGE_MAX_CHARS = 100_000;
const TOOL_MAX_CHARS = 4096;
/** Continuations tried for a Claude Code session resumed after it ended. */
const MAX_CONTINUATIONS = 20;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Where the settings live: the project's, the project's personal file, or the user's. */
const where = Flag.Literals("scope", ["project", "local", "user"]).pipe(
  Flag.withDescription(
    "project: .claude/settings.json, shared; local: .claude/settings.local.json, yours alone; user: ~/.claude/settings.json, every project",
  ),
  Flag.withDefault("project"),
);

const settingsPath = (
  environment: Environment,
  scope: "project" | "local" | "user",
) =>
  Effect.map(Path, (path) =>
    scope === "user"
      ? path.join(environment.home, ".claude", "settings.json")
      : path.join(
          environment.cwd,
          ".claude",
          scope === "local" ? "settings.local.json" : "settings.json",
        ),
  );

/** The settings file, or nothing when it does not exist; null when it is not JSON we can change. */
const readSettings = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!(yield* fs.exists(file))) return {} as ClaudeSettings;
    const text = yield* fs.readFileString(file);
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
        ? (value as ClaudeSettings)
        : null;
    } catch {
      return null;
    }
  });

const writeSettings = (file: string, settings: ClaudeSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(settings, null, 2) + "\n");
  });

/** Whether `rf` is on the PATH, which is how Claude Code will find it. */
const onPath = (environment: Environment) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    for (const dir of (environment.env.PATH ?? "").split(delimiter)) {
      if (dir && (yield* fs.exists(path.join(dir, "rf")))) return true;
    }
    return false;
  });

const install = Command.make(
  "install",
  {
    scope: where,
    tools: Flag.Boolean("tools").pipe(
      Flag.withDescription("Also log every tool call and its result"),
      Flag.withDefault(false),
    ),
    recall: Flag.Boolean("recall").pipe(
      Flag.withDescription(
        "Also fetch a context pack for every prompt, not only at the start",
      ),
      Flag.withDefault(false),
    ),
    budget: Flag.Int("budget").pipe(
      Flag.withDescription("Most tokens a context pack may use"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ scope, tools, recall, budget }) {
    const { flags, environment } = yield* session;
    const file = yield* settingsPath(environment, scope);
    const current = yield* readSettings(file);
    if (current === null) {
      yield* Console.error(
        `${file} is not a JSON object, so it is left alone. Fix it and run this again.`,
      );
      process.exitCode = 1;
      return;
    }
    const next = withRentfree(current, {
      tools,
      recall,
      ...Option.match(budget, {
        onNone: () => ({}),
        onSome: (b) => ({ budget: b }),
      }),
    });
    yield* writeSettings(file, next);
    const installed = rentfreeHooks(next);
    if (!(yield* onPath(environment))) {
      yield* Console.error(
        "Note: rf is not on your PATH, and Claude Code runs hooks through your shell. Install it with `npm install -g rentfree`.",
      );
    }
    yield* print(
      { file, hooks: installed },
      () =>
        [
          `Installed ${installed.length} hooks in ${file}:`,
          table(installed, ["event", "command"]),
          "Each Claude Code session here now starts with its memory, logs its turns, and is recapped when it ends.",
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Wire rentfree into Claude Code's hooks"));

const uninstall = Command.make(
  "uninstall",
  { scope: where },
  Effect.fn(function* ({ scope }) {
    const { flags, environment } = yield* session;
    const file = yield* settingsPath(environment, scope);
    const current = yield* readSettings(file);
    if (current === null) {
      yield* Console.error(
        `${file} is not a JSON object, so it is left alone.`,
      );
      process.exitCode = 1;
      return;
    }
    const removed = rentfreeHooks(current).length;
    if (removed > 0) yield* writeSettings(file, withoutRentfree(current));
    yield* print(
      { file, removed },
      () =>
        removed
          ? `Removed ${removed} rentfree hooks from ${file}; the rest are as they were.`
          : `No rentfree hooks in ${file}.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Remove rentfree's hooks, and only those"));

const status = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const { flags, environment } = yield* session;
    const rows: Array<{ scope: string; event: string; command: string }> = [];
    for (const scope of ["project", "local", "user"] as const) {
      const file = yield* settingsPath(environment, scope);
      const current = yield* readSettings(file);
      for (const hook of rentfreeHooks(current ?? {})) {
        rows.push({ scope, ...hook });
      }
    }
    yield* print(
      rows,
      () =>
        rows.length
          ? table(rows, ["scope", "event", "command"])
          : "No rentfree hooks here. Run `rf hooks install`.",
      flags.json,
    );
  }),
).pipe(
  Command.withDescription("Which rentfree hooks are installed, and where"),
);

/** What Claude Code sends a hook on stdin; only the fields used here. */
interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  prompt?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

/**
 * When a background command finishes, Claude Code hands its notification to
 * the model as a prompt, and runs the prompt hook for it as if the user had
 * typed it. Only what the user wrote is theirs to log or to search with.
 */
const TASK_NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g;
const userText = (prompt: string) =>
  prompt.replace(TASK_NOTIFICATION, "").trim();

/** A hook's own failure: one line on stderr, and never a blocked session. */
class HookProblem {
  readonly _tag = "HookProblem";
  constructor(readonly message: string) {}
}

/** The external id of a Claude Code session, or of its `n`th continuation. */
const externalIdFor = (sessionId: string, n: number) =>
  `claude-code:${sessionId}${n === 1 ? "" : `:${n}`}`;

/**
 * The rentfree session for a Claude Code session, made by the first event
 * it logs. The same Claude Code session always finds the same one; one
 * resumed after it ended continues in `:2`, then `:3`, so every hook in a
 * turn still agrees.
 */
const openSession = (api: Api, collectionId: string, sessionId: string) =>
  Effect.gen(function* () {
    for (let n = 1; n <= MAX_CONTINUATIONS; n += 1) {
      const externalId = externalIdFor(sessionId, n);
      const { session: found } = yield* api.run((rf) =>
        rf.sessions.start({ externalId, collectionId }),
      );
      if (!found.endedAt) return found;
    }
    return yield* Effect.fail(
      new HookProblem(`session ${sessionId} was resumed too many times`),
    );
  });

/**
 * The open rentfree session for a Claude Code session, without making one.
 * A Claude Code session that never logged anything has none, and so
 * nothing to end.
 */
const findOpenSession = (api: Api, collectionId: string, sessionId: string) =>
  Effect.gen(function* () {
    for (let n = 1; n <= MAX_CONTINUATIONS; n += 1) {
      const externalId = externalIdFor(sessionId, n);
      const { items } = yield* api.run((rf) =>
        rf.sessions.list({ collectionId, externalId, limit: 1 }),
      );
      // An api older than the filter answers with the newest session of any
      // name, which must not be ended in this one's place.
      const found = items.find((s) => s.externalId === externalId);
      if (!found) return null;
      if (!found.endedAt) return found;
    }
    return null;
  });

/** The collection hooks write to: rf.json's, else the login's, else the account's default. */
const hookCollection = (settings: Settings, api: Api) =>
  Effect.gen(function* () {
    const chosen =
      settings.project?.collectionId ?? settings.defaultCollectionId;
    if (chosen) return chosen;
    const me = yield* api.run((rf) => rf.me.get());
    const fallback = me.collections.find((c) => c.isDefault)?.id;
    if (fallback) return fallback;
    return yield* Effect.fail(
      new HookProblem("no collection; run `rf config set collection <id>`"),
    );
  });

const contextFor = (
  api: Api,
  collectionId: string,
  query: string | undefined,
  budget: Option.Option<number>,
) =>
  api.run((rf: Client) =>
    rf.context({
      collectionId,
      ...(query ? { query: clip(query, 2000) } : {}),
      ...Option.match(budget, {
        onNone: () => ({}),
        onSome: (b) => ({ tokenBudget: b }),
      }),
    }),
  );

/** Prints a pack for Claude Code to add to the model's context. */
const emit = (text: string) =>
  text ? Console.log(`# From rentfree's memory\n\n${text}`) : Effect.void;

const run = Command.make(
  "run",
  {
    event: Argument.Literals("event", Object.values(HOOK_EVENTS)),
    recall: Flag.Boolean("recall").pipe(Flag.withDefault(false)),
    budget: Flag.Int("budget").pipe(Flag.optional),
  },
  Effect.fn(function* ({ event, recall, budget }) {
    const body = Effect.gen(function* () {
      const platform = yield* Platform;
      let input: HookInput;
      try {
        input = JSON.parse(yield* platform.readStdin) as HookInput;
      } catch {
        return yield* Effect.fail(
          new HookProblem("stdin is not the JSON Claude Code sends a hook"),
        );
      }
      const sessionId = input.session_id;
      if (!sessionId) {
        return yield* Effect.fail(new HookProblem("no session_id on stdin"));
      }
      const { settings, api } = yield* agentSession;
      if (!settings.apiKey) {
        return yield* Effect.fail(
          new HookProblem("not logged in; run `rf init`"),
        );
      }
      const collectionId = yield* hookCollection(settings, api);
      const log = (
        events: Array<{
          type:
            "message.user" | "message.assistant" | "tool.call" | "tool.result";
          content: string;
          metadata?: Record<string, unknown>;
        }>,
      ) =>
        Effect.gen(function* () {
          const kept = events.filter((e) => e.content.trim() !== "");
          if (!kept.length) return;
          const open = yield* openSession(api, collectionId, sessionId);
          yield* api.run((rf) => rf.sessions.log(open.id, { events: kept }));
        });

      switch (event) {
        case "session-start": {
          // No session yet: the first event logged makes it, so a Claude
          // Code session that ends without one leaves nothing behind.
          const pack = yield* contextFor(api, collectionId, undefined, budget);
          yield* emit(pack.text);
          return;
        }
        case "prompt": {
          const prompt = userText(input.prompt ?? "");
          yield* log([
            { type: "message.user", content: clip(prompt, MESSAGE_MAX_CHARS) },
          ]);
          if (recall && prompt.trim()) {
            const pack = yield* contextFor(api, collectionId, prompt, budget);
            yield* emit(pack.text);
          }
          return;
        }
        case "stop": {
          // A Stop hook that already continued the turn has logged it.
          if (input.stop_hook_active) return;
          yield* log([
            {
              type: "message.assistant",
              content: clip(
                input.last_assistant_message ?? "",
                MESSAGE_MAX_CHARS,
              ),
            },
          ]);
          return;
        }
        case "session-end": {
          // Looked up, never made: Claude Code ends sessions whose start
          // no hook saw, and a session that logged nothing has no recap.
          const open = yield* findOpenSession(api, collectionId, sessionId);
          // Ending it is what starts the recap.
          if (open) yield* api.run((rf) => rf.sessions.end(open.id));
          return;
        }
        case "tool": {
          const tool = input.tool_name ?? "unknown";
          const asText = (value: unknown) =>
            typeof value === "string" ? value : JSON.stringify(value ?? null);
          yield* log([
            {
              type: "tool.call",
              content: clip(asText(input.tool_input), TOOL_MAX_CHARS),
              metadata: { tool },
            },
            {
              type: "tool.result",
              content: clip(asText(input.tool_response), TOOL_MAX_CHARS),
              metadata: { tool },
            },
          ]);
          return;
        }
      }
    });
    // A hook never blocks Claude Code and never prints on stdout when it
    // fails: one line on stderr, which Claude Code shows only in its
    // verbose view, and exit 0.
    yield* body.pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.squash(cause);
        const message =
          failure instanceof HookProblem
            ? failure.message
            : typeof failure === "object" &&
                failure !== null &&
                "_tag" in failure &&
                ["ApiError", "NotLoggedIn", "ApiUnreachable"].includes(
                  (failure as { _tag: string })._tag,
                )
              ? describeFailure(failure as ApiFailure)
              : String(failure);
        return Console.error(`rf hooks ${event}: ${message}`);
      }),
    );
  }),
).pipe(Command.unlisted);

export const hooks = Command.make("hooks").pipe(
  Command.withSubcommands([install, uninstall, status, run]),
  Command.withDescription(
    "Claude Code hooks: install, uninstall, status. Capture and memory, with no tokens spent",
  ),
);
