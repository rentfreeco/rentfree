import type { SessionEvent } from "@rentfree/sdk";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { kv, print, table } from "../output";
import { Platform } from "../platform";
import {
  collectionFlag,
  collectionFor,
  oneLine,
  session,
  textFrom,
} from "./shared";

/**
 * What may be logged. Declared here rather than imported, because the
 * contract's value would load zod into every command; the check below
 * fails to compile if the two lists ever differ.
 */
const EVENT_TYPES = [
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "note",
] as const;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const eventTypesMatch: Same<
  (typeof EVENT_TYPES)[number],
  SessionEvent["type"]
> = true;
void eventTypesMatch;

/** The most events one request may carry; the api's batch limit. */
const BATCH = 100;

const sessionArgument = Argument.String("session").pipe(
  Argument.withDescription("The session's id"),
);

const start = Command.make(
  "start",
  {
    title: Flag.String("title").pipe(
      Flag.withDescription("What the session is about"),
      Flag.optional,
    ),
    externalId: Flag.String("external-id").pipe(
      Flag.withDescription(
        "Your own id for this run; the same one always finds the same session",
      ),
      Flag.optional,
    ),
    collection: collectionFlag,
  },
  Effect.fn(function* ({ title, externalId, collection }) {
    const { flags, settings, api } = yield* session;
    const collectionId = yield* collectionFor(collection, { settings, api });
    if (!collectionId) return;
    const started = yield* api.run((rf) =>
      rf.sessions.start({
        collectionId,
        ...(Option.isSome(title) ? { title: title.value } : {}),
        ...(Option.isSome(externalId) ? { externalId: externalId.value } : {}),
      }),
    );
    // Just the id, so `SESSION=$(rf session start)` works.
    yield* print(started, () => started.session.id, flags.json);
  }),
).pipe(Command.withDescription("Start a session, and print its id"));

const end = Command.make(
  "end",
  {
    session: sessionArgument,
    title: Flag.String("title").pipe(
      Flag.withDescription("A title to give it as it ends"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ session: id, title }) {
    const { flags, api } = yield* session;
    const ended = yield* api.run((rf) =>
      rf.sessions.update(id, {
        ended: true,
        ...(Option.isSome(title) ? { title: title.value } : {}),
      }),
    );
    yield* print(
      ended,
      () =>
        `Ended ${ended.id}. A recap of anything not yet read starts on its own.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("End a session, which starts a recap"));

const show = Command.make(
  "show",
  { session: sessionArgument },
  Effect.fn(function* ({ session: id }) {
    const { flags, api } = yield* session;
    const s = yield* api.run((rf) => rf.sessions.get(id));
    yield* print(
      s,
      () =>
        kv([
          ["id", s.id],
          ["title", s.title],
          ["collection", s.collectionId],
          ["agent", s.agentId],
          ["external id", s.externalId],
          ["started", s.startedAt],
          ["ended", s.endedAt],
        ]),
      flags.json,
    );
  }),
).pipe(Command.withDescription("One session"));

const list = Command.make(
  "list",
  {
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Most to show, 1 to 100"),
      Flag.withDefault(20),
    ),
    collection: collectionFlag,
  },
  Effect.fn(function* ({ limit, collection }) {
    const { flags, settings, api } = yield* session;
    const collectionId = yield* collectionFor(collection, { settings, api });
    if (!collectionId) return;
    const page = yield* api.run((rf) =>
      rf.sessions.list({ collectionId, limit }),
    );
    yield* print(
      page,
      () =>
        page.items.length === 0
          ? "No sessions."
          : table(
              page.items.map((s) => ({
                id: s.id,
                title: s.title,
                started: s.startedAt,
                ended: s.endedAt,
              })),
              ["id", "title", "started", "ended"],
            ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Sessions in a collection, newest first"));

const events = Command.make(
  "events",
  {
    session: sessionArgument,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Most to show, 1 to 100"),
      Flag.withDefault(50),
    ),
  },
  Effect.fn(function* ({ session: id, limit }) {
    const { flags, api } = yield* session;
    const page = yield* api.run((rf) => rf.sessions.events(id, { limit }));
    yield* print(
      page,
      () =>
        page.items.length === 0
          ? "No events."
          : table(
              page.items.map((e) => ({
                id: e.id,
                type: e.type,
                content: oneLine(e.content, 120),
              })),
              ["id", "type", "content"],
            ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("A session's events, oldest first"));

export const sessionCommand = Command.make("session").pipe(
  Command.withSubcommands([start, end, show, list, events]),
  Command.withDescription("Sessions: start, end, show, list, events"),
);

/** One event as a line of `--batch` input gives it. */
interface EventLine {
  type: (typeof EVENT_TYPES)[number];
  content: string;
  metadata?: Record<string, unknown>;
}

/** Reads `--batch` input: one JSON object per line, blank lines ignored. */
function parseBatch(text: string): EventLine[] | string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const out: EventLine[] = [];
  for (const [i, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return `Line ${i + 1} is not JSON.`;
    }
    const v = value as Partial<EventLine>;
    if (
      typeof v !== "object" ||
      v === null ||
      !EVENT_TYPES.includes(v.type as EventLine["type"]) ||
      typeof v.content !== "string"
    ) {
      return `Line ${i + 1} needs a type (${EVENT_TYPES.join(", ")}) and a content.`;
    }
    out.push(v as EventLine);
  }
  return out.length ? out : "No events on stdin.";
}

/**
 * `rf log`: one event, with its content from --content or stdin, or
 * `--batch` events as JSON lines on stdin, sent 100 to a request.
 */
export const log = Command.make(
  "log",
  {
    session: sessionArgument,
    type: Flag.Literals("type", EVENT_TYPES).pipe(
      Flag.withDescription("What kind of event; not needed with --batch"),
      Flag.optional,
    ),
    content: Flag.String("content").pipe(
      Flag.withDescription("The event's text; otherwise read from stdin"),
      Flag.optional,
    ),
    meta: Flag.KeyValuePair("meta").pipe(
      Flag.withDescription("Metadata, as key=value; repeat for more"),
      Flag.optional,
    ),
    batch: Flag.Boolean("batch").pipe(
      Flag.withDescription(
        'Read many events from stdin, one JSON object a line: {"type":…,"content":…}',
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ session: id, type, content, meta, batch }) {
    const { flags, api } = yield* session;
    const fail = (message: string) =>
      Console.error(message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      );

    let toLog: EventLine[];
    if (batch) {
      const parsed = parseBatch(yield* (yield* Platform).readStdin);
      if (typeof parsed === "string") return yield* fail(parsed);
      toLog = parsed;
    } else {
      if (Option.isNone(type)) {
        return yield* fail("Pass --type, or --batch with JSON lines on stdin.");
      }
      const text = Option.isSome(content)
        ? content.value
        : yield* textFrom("-");
      if (text === "")
        return yield* fail("Nothing to log: the content is empty.");
      toLog = [
        {
          type: type.value,
          content: text,
          ...(Option.isSome(meta) ? { metadata: meta.value } : {}),
        },
      ];
    }

    // Each request is all or none; more than one request is not.
    const logged: SessionEvent[] = [];
    for (let i = 0; i < toLog.length; i += BATCH) {
      const slice = toLog.slice(i, i + BATCH);
      const answer = yield* api.run((rf) =>
        rf.sessions.log(id, { events: slice }),
      );
      logged.push(...answer.events);
    }
    yield* print(
      { events: logged },
      () =>
        logged.length === 1
          ? `Logged event ${logged[0]!.id}.`
          : `Logged ${logged.length} events.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Log events to a session"));
