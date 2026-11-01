import type { AddedSource, Source } from "@rentfree/sdk";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { kv, print, table } from "../output";
import { Platform } from "../platform";
import { collectionFlag, collectionFor, session } from "./shared";

/** Inline text sources stop at 1 MB; larger text goes up as a file. */
const INLINE_MAX_BYTES = 1024 * 1024;

/** How a file is sent, by its extension. */
const TEXT_FORMATS: Record<string, "markdown" | "text"> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".txt": "text",
  ".text": "text",
};
const UPLOAD_TYPES: Record<
  string,
  "application/pdf" | "text/markdown" | "text/plain"
> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
  ".text": "text/plain",
};

const isUrl = (value: string) => /^https?:\/\//i.test(value);

const sourceRow = (s: Source) => ({
  id: s.id,
  kind: s.kind,
  status: s.status,
  version: s.version,
  title: s.title ?? s.uri ?? s.externalId,
});

/** What happened, in a word, from the status the api answered with. */
const outcome = (status: number) =>
  status === 201 ? "Added" : status === 202 ? "Queued" : "Already had";

const sourceArgument = Argument.String("id").pipe(
  Argument.withDescription("The source's id"),
);

const add = Command.make(
  "add",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription(
        "A file path, an http(s) URL, or - to read text from stdin",
      ),
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription("What to call it; a file is named after itself"),
      Flag.optional,
    ),
    externalId: Flag.String("external-id").pipe(
      Flag.withDescription(
        "Your own name for it; otherwise the file's full path, or the URL",
      ),
      Flag.optional,
    ),
    wait: Flag.Boolean("wait").pipe(
      Flag.withDescription("Wait until it is ready, or has failed"),
      Flag.withDefault(false),
    ),
    collection: collectionFlag,
  },
  Effect.fn(function* ({ input, title, externalId, wait, collection }) {
    const { flags, environment, settings, api } = yield* session;
    const collectionId = yield* collectionFor(collection, { settings, api });
    if (!collectionId) return;
    const given = {
      ...(Option.isSome(title) ? { title: title.value } : {}),
      collectionId,
    };
    const named = (fallback: string | undefined) => {
      const id = Option.getOrUndefined(externalId) ?? fallback;
      return id ? { externalId: id } : {};
    };

    let answer: { data: AddedSource; status: number };
    if (input === "-") {
      const content = yield* (yield* Platform).readStdin;
      answer = yield* api.run((rf) =>
        rf.request("addSource", {
          body: { kind: "text", content, ...given, ...named(undefined) },
        }),
      );
    } else if (isUrl(input)) {
      answer = yield* api.run((rf) =>
        rf.request("addSource", {
          body: { kind: "url", url: input, ...given, ...named(input) },
        }),
      );
    } else {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const file = path.resolve(environment.cwd, input);
      if (!(yield* fs.exists(file))) {
        yield* Console.error(`No file at ${file}.`);
        process.exitCode = 1;
        return;
      }
      const extension = path.extname(file).toLowerCase();
      const bytes = yield* fs.readFile(file);
      const name = path.basename(file);
      const fileGiven = {
        title: name,
        ...given,
        ...named(`file:${file}`),
      };
      const format = TEXT_FORMATS[extension];
      if (format && bytes.byteLength <= INLINE_MAX_BYTES) {
        // Sent inline, so the api can tell unchanged text from changed.
        const content = new TextDecoder().decode(bytes);
        answer = yield* api.run((rf) =>
          rf.request("addSource", {
            body: { kind: "text", content, format, ...fileGiven },
          }),
        );
      } else {
        const contentType = UPLOAD_TYPES[extension];
        if (!contentType) {
          yield* Console.error(
            `Cannot add ${name}: rentfree reads ${Object.keys(UPLOAD_TYPES).join(", ")} files.`,
          );
          process.exitCode = 1;
          return;
        }
        const data = yield* api.run((rf) =>
          rf.sources.addFile({
            filename: name,
            contentType,
            data: bytes,
            ...fileGiven,
          }),
        );
        answer = { data, status: 202 };
      }
    }

    let source = answer.data;
    if (
      wait &&
      (source.status === "pending" || source.status === "processing")
    ) {
      source = yield* api.run((rf) => rf.sources.waitReady(source.id));
    }
    if (source.status === "failed") {
      yield* Console.error(
        `${source.id} failed: ${source.error ?? "no reason given"}`,
      );
      process.exitCode = 1;
    }
    const duplicate = answer.data.duplicateOf;
    yield* print(
      source,
      () =>
        [
          `${outcome(answer.status)} ${source.id}: ${source.title ?? source.uri ?? "untitled"}, version ${source.version}, ${source.status}.`,
          ...(duplicate
            ? [
                `Same text as ${duplicate.id}: ${duplicate.title ?? duplicate.externalId ?? "untitled"}. Both are kept.`,
              ]
            : []),
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(
  Command.withDescription(
    "Add a file, a URL, or stdin; adding the same one again updates it",
  ),
);

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
      rf.sources.list({ collectionId, limit }),
    );
    yield* print(
      page,
      () =>
        page.items.length === 0
          ? "No sources."
          : table(page.items.map(sourceRow), [
              "id",
              "kind",
              "status",
              "version",
              "title",
            ]),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Sources in a collection, newest first"));

const show = Command.make(
  "show",
  { id: sourceArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const s = yield* api.run((rf) => rf.sources.get(id));
    yield* print(
      s,
      () =>
        kv([
          ["id", s.id],
          ["title", s.title],
          ["kind", `${s.kind}, ${s.format}`],
          ["status", s.error ? `${s.status}: ${s.error}` : s.status],
          ["version", s.version],
          ["from", s.uri],
          ["external id", s.externalId],
          ["updated", s.updatedAt],
        ]),
      flags.json,
    );
  }),
).pipe(Command.withDescription("One source, with its ingest status"));

const content = Command.make(
  "content",
  { id: sourceArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const text = yield* api.run((rf) => rf.sources.content(id));
    yield* print({ content: text }, () => text, flags.json);
  }),
).pipe(Command.withDescription("A ready source's text"));

const remove = Command.make(
  "remove",
  { id: sourceArgument },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    yield* api.run((rf) => rf.sources.remove(id));
    yield* print({ id, removed: true }, () => `Removed ${id}.`, flags.json);
  }),
).pipe(Command.withDescription("Remove a source and its passages"));

const refresh = Command.make(
  "refresh",
  {
    id: sourceArgument,
    wait: Flag.Boolean("wait").pipe(
      Flag.withDescription("Wait until it is ready, or has failed"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ id, wait }) {
    const { flags, api } = yield* session;
    let s = yield* api.run((rf) => rf.sources.refresh(id));
    if (wait) s = yield* api.run((rf) => rf.sources.waitReady(id));
    if (s.status === "failed") process.exitCode = 1;
    yield* print(
      s,
      () =>
        `${s.id}: version ${s.version}, ${s.status}${s.error ? `: ${s.error}` : ""}.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Fetch a URL source again"));

export const sources = Command.make("sources").pipe(
  Command.withSubcommands([add, list, show, content, remove, refresh]),
  Command.withDescription("Sources: add, list, show, content, remove, refresh"),
);
