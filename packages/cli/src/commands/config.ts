import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { keyOrigin, readCredentials, writeProjectConfig } from "../config";
import { kv, print } from "../output";
import { AGENT_HERE, session } from "./shared";

const embedModel = Command.make(
  "embed-model",
  {
    model: Argument.String("model").pipe(
      Argument.withDescription(
        "A supported model, optionally with a size: openai/text-embedding-3-large@1024",
      ),
    ),
  },
  Effect.fn(function* ({ model }) {
    const { flags, api } = yield* session;
    const at = model.lastIndexOf("@");
    const size = at > 0 ? Number(model.slice(at + 1)) : null;
    const name = at > 0 && Number.isInteger(size) ? model.slice(0, at) : model;
    const me = yield* api.run((rf) =>
      rf.me.update({
        embedModel: name,
        ...(at > 0 && Number.isInteger(size) ? { embedDimensions: size } : {}),
      }),
    );
    yield* print(
      me,
      () =>
        `Embedding model is now ${me.embedModel}${me.embedDimensions ? `@${me.embedDimensions}` : ""}.`,
      flags.json,
    );
  }),
).pipe(
  Command.withDescription(
    "Choose the embedding model, while the account has no content yet",
  ),
);

const collection = Command.make(
  "collection",
  { id: Argument.String("id") },
  Effect.fn(function* ({ id }) {
    const { flags, environment, api } = yield* session;
    const { collections: known } = yield* api.run((rf) =>
      rf.collections.list(),
    );
    const match = known.find((c) => c.id === id);
    if (!match) {
      yield* Console.error(
        `No active collection ${id}. See \`rf collections list\`.`,
      );
      process.exitCode = 1;
      return;
    }
    const written = yield* writeProjectConfig(environment, {
      collectionId: id,
    });
    yield* print(
      written,
      () => `${written.path} now names collection ${id} (${match.name}).`,
      flags.json,
    );
  }),
).pipe(
  Command.withDescription("Make this project use a collection by default"),
);

const agent = Command.make(
  "agent",
  { id: Argument.String("id") },
  Effect.fn(function* ({ id }) {
    const { flags, environment, api } = yield* session;
    const { agents: known } = yield* api.run((rf) =>
      rf.agents.list({ status: "active" }),
    );
    const match = known.find((a) => a.id === id);
    if (!match) {
      yield* Console.error(`No live agent ${id}. See \`rf agents list\`.`);
      process.exitCode = 1;
      return;
    }
    const written = yield* writeProjectConfig(environment, { agentId: id });
    const stored = (yield* readCredentials(environment)).agents[id];
    yield* print(
      { ...written, keyStored: Boolean(stored) },
      () =>
        [
          `${written.path} now names agent ${id} (${match.name}).`,
          stored
            ? AGENT_HERE
            : `No key is stored for it yet, so even an agent running rf here uses your login. Mint one with \`rf keys create --name <name> --agent ${id} --use\`.`,
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(
  Command.withDescription(
    "Name the agent Claude Code and its hooks act as in this project",
  ),
);

const show = Command.make(
  "show",
  {},
  Effect.fn(function* () {
    const { flags, settings } = yield* session;
    yield* print(
      settings,
      () =>
        kv([
          ["api", settings.apiUrl],
          [
            "key",
            settings.apiKey
              ? `${settings.apiKey.slice(0, 11)}… (${keyOrigin(settings)})`
              : "none",
          ],
          ["profile", settings.profile],
          ["collection", settings.project?.collectionId ?? "-"],
          [
            "agent",
            settings.project?.agentId
              ? settings.keySource === "agent"
                ? `${settings.project.agentId} (acting as it)`
                : `${settings.project.agentId} (when an agent runs rf here)`
              : "-",
          ],
        ]),
      flags.json,
    );
  }),
).pipe(
  Command.withDescription(
    "What commands here run with, and where it came from",
  ),
);

const set = Command.make("set").pipe(
  Command.withSubcommands([embedModel, collection, agent]),
  Command.withDescription("Change a setting"),
);

export const config = Command.make("config").pipe(
  Command.withSubcommands([set, show]),
  Command.withDescription(
    "Settings: the project's collection and agent, the embedding model",
  ),
);
