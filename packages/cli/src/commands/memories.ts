import type { Memory } from "@rentfree/sdk";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { kv, print, table } from "../output";
import {
  collectionFlag,
  collectionFor,
  oneLine,
  session,
  textFrom,
} from "./shared";

const memoryRow = (m: Memory) => ({
  id: m.id,
  type: m.type,
  tier: m.tier,
  importance: m.importanceNow.toFixed(2),
  content: oneLine(m.subject ? `${m.subject}: ${m.content}` : m.content, 100),
});

const idArgument = Argument.String("id").pipe(
  Argument.withDescription("The memory's id"),
);

/** `rf remember`: writes one memory, and prints its id. */
export const remember = Command.make(
  "remember",
  {
    content: Argument.String("content").pipe(
      Argument.withDescription("What to remember; `-` reads it from stdin"),
    ),
    type: Flag.String("type").pipe(
      Flag.withDescription("fact, preference, decision, plan, or your own"),
      Flag.withDefault("fact"),
    ),
    tier: Flag.Literals("tier", ["long", "working"]).pipe(
      Flag.withDescription(
        "long lasts and fades slowly; working expires, in a day by default",
      ),
      Flag.withDefault("long"),
    ),
    subject: Flag.String("subject").pipe(
      Flag.withDescription("What it is about, such as a person or a project"),
      Flag.optional,
    ),
    importance: Flag.Finite("importance").pipe(
      Flag.withDescription("0 to 1; 0.5 when left out"),
      Flag.optional,
    ),
    expires: Flag.String("expires").pipe(
      Flag.withDescription(
        "For a working memory: when it expires, ISO 8601, within 30 days",
      ),
      Flag.optional,
    ),
    collection: collectionFlag,
  },
  Effect.fn(function* (input) {
    const { flags, settings, api } = yield* session;
    const collectionId = yield* collectionFor(input.collection, {
      settings,
      api,
    });
    if (!collectionId) return;
    const content = yield* textFrom(input.content);
    const made = yield* api.run((rf) =>
      rf.remember({
        collectionId,
        content,
        type: input.type,
        tier: input.tier,
        ...Option.match(input.subject, {
          onNone: () => ({}),
          onSome: (subject) => ({ subject }),
        }),
        ...Option.match(input.importance, {
          onNone: () => ({}),
          onSome: (importance) => ({ importance }),
        }),
        ...Option.match(input.expires, {
          onNone: () => ({}),
          onSome: (expiresAt) => ({ expiresAt }),
        }),
      }),
    );
    yield* print(made, () => `Remembered ${made.id}.`, flags.json);
  }),
).pipe(Command.withDescription("Write a memory"));

const list = Command.make(
  "list",
  {
    status: Flag.Literals("status", ["active", "archived", "expired"]).pipe(
      Flag.withDescription("Which memories; active by default"),
      Flag.withDefault("active"),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Most to show, 1 to 100"),
      Flag.withDefault(20),
    ),
    collection: collectionFlag,
  },
  Effect.fn(function* ({ status, limit, collection }) {
    const { flags, settings, api } = yield* session;
    const collectionId = yield* collectionFor(collection, { settings, api });
    if (!collectionId) return;
    const page = yield* api.run((rf) =>
      rf.memories.list({ collectionId, status, limit }),
    );
    yield* print(
      page,
      () =>
        page.items.length === 0
          ? `No ${status} memories.`
          : table(page.items.map(memoryRow), [
              "id",
              "type",
              "tier",
              "importance",
              "content",
            ]) + (page.nextCursor ? "\n(more; raise --limit to see them)" : ""),
      flags.json,
    );
  }),
).pipe(Command.withDescription("List memories, newest first"));

const show = Command.make(
  "show",
  { id: idArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const m = yield* api.run((rf) => rf.memories.get(id));
    yield* print(
      m,
      () =>
        [
          kv([
            ["id", m.id],
            ["type", `${m.type}, ${m.tier}, ${m.status}`],
            ["subject", m.subject],
            [
              "importance",
              `${m.importanceNow.toFixed(2)} now, ${m.importance.toFixed(2)} set`,
            ],
            ["version", m.version],
            ["by", m.origin],
            ["created", m.createdAt],
            ["expires", m.expiresAt],
          ]),
          "",
          m.content,
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(Command.withDescription("One memory in full"));

const edit = Command.make(
  "edit",
  {
    id: idArgument,
    content: Flag.String("content").pipe(
      Flag.withDescription("The corrected text; `-` reads it from stdin"),
      Flag.optional,
    ),
    subject: Flag.String("subject").pipe(
      Flag.withDescription("What it is about"),
      Flag.optional,
    ),
    importance: Flag.Finite("importance").pipe(
      Flag.withDescription("0 to 1"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ id, content, subject, importance }) {
    const { flags, api } = yield* session;
    if (
      Option.isNone(content) &&
      Option.isNone(subject) &&
      Option.isNone(importance)
    ) {
      yield* Console.error(
        "Nothing to change; pass --content, --subject, or --importance.",
      );
      process.exitCode = 1;
      return;
    }
    const text = Option.isSome(content)
      ? yield* textFrom(content.value)
      : undefined;
    const m = yield* api.run((rf) =>
      rf.memories.update(id, {
        ...(text !== undefined ? { content: text } : {}),
        ...(Option.isSome(subject) ? { subject: subject.value } : {}),
        ...(Option.isSome(importance) ? { importance: importance.value } : {}),
      }),
    );
    yield* print(
      m,
      () => `Updated ${m.id}, now version ${m.version}.`,
      flags.json,
    );
  }),
).pipe(
  Command.withDescription("Correct a memory; a new text is a new version"),
);

const archive = Command.make(
  "archive",
  { id: idArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const m = yield* api.run((rf) => rf.memories.archive(id));
    yield* print(m, () => `Archived ${m.id}.`, flags.json);
  }),
).pipe(
  Command.withDescription(
    "Retire a memory; its history and sources stay, and restore brings it back",
  ),
);

const restore = Command.make(
  "restore",
  { id: idArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const m = yield* api.run((rf) => rf.memories.restore(id));
    yield* print(m, () => `Restored ${m.id}.`, flags.json);
  }),
).pipe(Command.withDescription("Bring an archived memory back"));

const history = Command.make(
  "history",
  { id: idArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const { items } = yield* api.run((rf) => rf.memories.history(id));
    yield* print(
      items,
      () =>
        table(
          items.map((change) => ({
            when: change.createdAt,
            op: change.op,
            by: change.actor,
            reason: change.reason,
          })),
          ["when", "op", "by", "reason"],
        ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Every change to a memory, newest first"));

const sources = Command.make(
  "sources",
  { id: idArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const { items } = yield* api.run((rf) => rf.memories.sources(id));
    yield* print(
      items,
      () =>
        items.length === 0
          ? "No recorded sources; it was written directly."
          : table(
              items.map((s) => ({
                from: s.sessionId
                  ? `session ${s.sessionId} event ${s.eventId}`
                  : `source ${s.sourceId}`,
                quote: s.quote ? oneLine(s.quote, 100) : null,
              })),
              ["from", "quote"],
            ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Where a memory came from"));

export const memories = Command.make("memories").pipe(
  Command.withSubcommands([
    list,
    show,
    edit,
    archive,
    restore,
    history,
    sources,
  ]),
  Command.withDescription(
    "Memories: list, show, edit, archive, restore, history, sources",
  ),
);
