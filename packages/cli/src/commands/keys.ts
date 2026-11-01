import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  readCredentials,
  writeCredentials,
  writeProjectConfig,
} from "../config";
import { print, table } from "../output";
import { AGENT_HERE, session, type CreatedKey } from "./shared";

const list = Command.make(
  "list",
  {
    revoked: Flag.Boolean("revoked").pipe(
      Flag.withDescription("Show revoked keys instead of live ones"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ revoked }) {
    const { flags, api } = yield* session;
    const { keys } = yield* api.run((rf) =>
      rf.keys.list({ status: revoked ? "revoked" : "active" }),
    );
    yield* print(
      keys,
      () =>
        keys.length === 0
          ? revoked
            ? "No revoked keys."
            : "No keys."
          : table(
              keys.map((k) => ({
                id: k.id,
                prefix: `${k.keyPrefix}…`,
                name: k.name,
                for: k.agentId ? `agent ${k.agentId}` : "user-level",
                [revoked ? "revoked" : "last used"]: revoked
                  ? k.revokedAt
                  : k.lastUsedAt,
              })),
              [
                "id",
                "prefix",
                "name",
                "for",
                revoked ? "revoked" : "last used",
              ],
            ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("List keys"));

const create = Command.make(
  "create",
  {
    name: Flag.String("name").pipe(
      Flag.withDescription('What the key is for, such as "CI on GitHub"'),
    ),
    agent: Flag.String("agent").pipe(
      Flag.withDescription(
        "Mint the key for this agent; without it, a user-level key",
      ),
      Flag.optional,
    ),
    use: Flag.Boolean("use").pipe(
      Flag.withDescription(
        "Store the key and make Claude Code and its hooks act as its agent in this project",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ name, agent, use }) {
    const { flags, environment, api } = yield* session;
    const agentId = agent._tag === "Some" ? agent.value : null;
    const key = yield* api.run((rf) =>
      rf.keys.create({ name, ...(agentId ? { agentId } : {}) }),
    );
    if (use) {
      if (!agentId) {
        yield* Console.error(
          "--use needs --agent: a project acts as an agent, not as you.",
        );
        process.exitCode = 1;
        return;
      }
      yield* storeAgentKey(environment, agentId, key);
    }
    yield* print(
      key,
      () =>
        [
          `Key ${key.keyPrefix}… for ${agentId ? `agent ${agentId}` : "you"}. Shown once; it is not stored anywhere else:`,
          "",
          `  ${key.apiKey ?? ""}`,
          ...(use
            ? [
                "",
                `Stored, and rf.json now names agent ${agentId}. ${AGENT_HERE}`,
              ]
            : []),
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Mint a key; the secret is shown once"));

const revoke = Command.make(
  "revoke",
  {
    key: Argument.String("key").pipe(
      Argument.withDescription("The key's id or its prefix, as listed"),
    ),
  },
  Effect.fn(function* ({ key }) {
    const { flags, api } = yield* session;
    const { keys } = yield* api.run((rf) => rf.keys.list({ status: "active" }));
    const target = keys.find(
      (k) => k.id === key || k.keyPrefix === key.replace(/…$/, ""),
    );
    if (!target) {
      yield* Console.error(
        `No live key with id or prefix ${key}. See \`rf keys list\`.`,
      );
      process.exitCode = 1;
      return;
    }
    const revoked = yield* api.run((rf) => rf.keys.revoke(target.id));
    yield* print(
      revoked,
      () => `Revoked key ${revoked.keyPrefix}… (${revoked.name ?? "unnamed"}).`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Revoke a key by id or prefix"));

export const keys = Command.make("keys").pipe(
  Command.withSubcommands([list, create, revoke]),
  Command.withDescription("API keys: list, mint, revoke"),
);

/** Keeps an agent's key beside the login and makes the project act as it. */
export const storeAgentKey = (
  environment: Parameters<typeof readCredentials>[0],
  agentId: string,
  key: CreatedKey,
) =>
  Effect.gen(function* () {
    if (!key.apiKey) return;
    const credentials = yield* readCredentials(environment);
    credentials.agents[agentId] = {
      apiKey: key.apiKey,
      keyPrefix: key.keyPrefix,
    };
    yield* writeCredentials(environment, credentials);
    yield* writeProjectConfig(environment, { agentId });
  });
