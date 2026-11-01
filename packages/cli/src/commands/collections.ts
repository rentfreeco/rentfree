import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { print, table } from "../output";
import { session, type Collection } from "./shared";

const row = (c: Collection) => ({
  id: c.id,
  name: c.name,
  default: c.isDefault ? "default" : "",
  archived: c.archivedAt ?? "",
});

const one = (c: Collection) =>
  `${c.id}  ${c.name}${c.isDefault ? "  (default)" : ""}${c.archivedAt ? "  archived" : ""}`;

const list = Command.make(
  "list",
  {
    archived: Flag.Boolean("archived").pipe(
      Flag.withDescription("Show archived collections instead of active ones"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ archived }) {
    const { flags, api } = yield* session;
    const { collections } = yield* api.run((rf) =>
      rf.collections.list({ status: archived ? "archived" : "active" }),
    );
    yield* print(
      collections,
      () =>
        collections.length === 0
          ? archived
            ? "No archived collections."
            : "No collections."
          : table(
              collections.map(row),
              archived ? ["id", "name", "archived"] : ["id", "name", "default"],
            ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("List collections"));

const create = Command.make(
  "create",
  { name: Argument.String("name") },
  Effect.fn(function* ({ name }) {
    const { flags, api } = yield* session;
    const made = yield* api.run((rf) => rf.collections.create({ name }));
    yield* print(made, () => `Created collection ${one(made)}`, flags.json);
  }),
).pipe(Command.withDescription("Create a collection"));

const rename = Command.make(
  "rename",
  { id: Argument.String("id"), name: Argument.String("name") },
  Effect.fn(function* ({ id, name }) {
    const { flags, api } = yield* session;
    const made = yield* api.run((rf) => rf.collections.update(id, { name }));
    yield* print(made, () => `Renamed collection ${one(made)}`, flags.json);
  }),
).pipe(Command.withDescription("Rename a collection"));

const setDefault = Command.make(
  "set-default",
  { id: Argument.String("id") },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const made = yield* api.run((rf) =>
      rf.collections.update(id, { isDefault: true }),
    );
    yield* print(
      made,
      () => `Default collection is now ${one(made)}`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Make a collection the default"));

const archive = Command.make(
  "archive",
  { id: Argument.String("id") },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const made = yield* api.run((rf) => rf.collections.archive(id));
    yield* print(
      made,
      () =>
        `Archived collection ${made.id} (${made.name}). It can still be read; nothing new goes in.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Archive a collection; it stays readable"));

export const collections = Command.make("collections").pipe(
  Command.withSubcommands([list, create, rename, setDefault, archive]),
  Command.withDescription(
    "Collections: list, create, rename, set-default, archive",
  ),
);
