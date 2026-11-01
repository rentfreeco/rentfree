import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { print, table } from "../output";
import {
  collectionFlag,
  collectionFor,
  commaList,
  oneLine,
  session,
} from "./shared";

/**
 * `rf context`: the one call an agent makes per turn. Prints the pack's
 * text and nothing else, so it can go straight into a prompt.
 */
export const context = Command.make(
  "context",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription(
        "What the next turn is about; without one, the profile and the most important memories",
      ),
      Argument.optional,
    ),
    collection: collectionFlag,
    budget: Flag.Int("budget").pipe(
      Flag.withDescription("Most tokens the pack may use, 200 to 16000"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ query, collection, budget }) {
    const { flags, settings, api } = yield* session;
    const collectionId = yield* collectionFor(collection, { settings, api });
    if (!collectionId) return;
    const pack = yield* api.run((rf) =>
      rf.context({
        collectionId,
        ...Option.match(query, {
          onNone: () => ({}),
          onSome: (q) => ({ query: q }),
        }),
        ...Option.match(budget, {
          onNone: () => ({}),
          onSome: (b) => ({ tokenBudget: b }),
        }),
      }),
    );
    // An empty collection makes an empty pack: print nothing at all, so a
    // hook adds nothing to the prompt.
    if (!flags.json && pack.text === "") return;
    yield* print(pack, () => pack.text, flags.json);
  }),
).pipe(
  Command.withDescription(
    "What an agent needs for its next turn, within a token budget",
  ),
);

/** `rf search`: memories and passages by meaning and by words, one line each. */
export const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription("What to look for"),
    ),
    collection: Flag.String("collection").pipe(
      Flag.withDescription(
        "Collection ids to search, comma-separated; otherwise every one the key may read",
      ),
      Flag.optional,
    ),
    kind: Flag.Literals("kind", ["memory", "chunk"]).pipe(
      Flag.withDescription("Only memories, or only document passages"),
      Flag.optional,
    ),
    type: Flag.String("type").pipe(
      Flag.withDescription("Only memories of these types, comma-separated"),
      Flag.optional,
    ),
    tier: Flag.String("tier").pipe(
      Flag.withDescription("Only memories in these tiers, comma-separated"),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Most hits of each kind, 1 to 50"),
      Flag.withDefault(10),
    ),
  },
  Effect.fn(function* ({ query, collection, kind, type, tier, limit }) {
    const { flags, api } = yield* session;
    const collectionIds = commaList(Option.getOrUndefined(collection));
    const types = commaList(Option.getOrUndefined(type));
    const tiers = commaList(Option.getOrUndefined(tier));
    const found = yield* api.run((rf) =>
      rf.search({
        query,
        limit,
        ...(collectionIds ? { collectionIds } : {}),
        ...(Option.isSome(kind) ? { kinds: [kind.value] } : {}),
        ...(types ? { types } : {}),
        ...(tiers ? { tiers } : {}),
      }),
    );
    const rows = [
      ...found.memories.map((m) => ({
        kind: "memory",
        id: m.id,
        score: m.score.toFixed(4),
        text: oneLine(m.subject ? `${m.subject}: ${m.content}` : m.content),
      })),
      ...found.chunks.map((c) => ({
        kind: "chunk",
        id: c.id,
        score: c.score.toFixed(4),
        text: oneLine(
          `${[c.source.title ?? "Untitled", c.headingPath]
            .filter(Boolean)
            .join(" › ")}: ${c.text}`,
        ),
      })),
    ];
    yield* print(
      found,
      () =>
        rows.length === 0
          ? "Nothing found."
          : table(rows, ["kind", "id", "score", "text"]) +
            (found.mode === "text"
              ? "\n(matched by words only; the question could not be embedded)"
              : ""),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Find memories and document passages"));

/** `rf profile`: a collection's standing summary, as recap last wrote it. */
export const profile = Command.make(
  "profile",
  { collection: collectionFlag },
  Effect.fn(function* ({ collection }) {
    const { flags, settings, api } = yield* session;
    const collectionId = yield* collectionFor(collection, { settings, api });
    if (!collectionId) return;
    const found = yield* api
      .run((rf) => rf.collections.profile(collectionId))
      .pipe(
        Effect.catchTag("ApiError", (error) =>
          error.error === "not_found"
            ? Effect.succeed(null)
            : Effect.fail(error),
        ),
      );
    if (!found) {
      // A profile appears once recap has read something; not having one is
      // not a failure.
      yield* Console.error(
        `No profile for ${collectionId} yet. Recap writes one once it has read some sessions.`,
      );
      return;
    }
    yield* print(found, () => found.content, flags.json);
  }),
).pipe(
  Command.withDescription("A collection's profile, as recap last wrote it"),
);
