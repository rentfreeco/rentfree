import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { print, table } from "../output";
import { storeAgentKey } from "./keys";
import { AGENT_HERE, commaList, session, yesNo, type Agent } from "./shared";

const agentRow = (a: Agent) => ({
  id: a.id,
  name: a.name,
  read: yesNo(a.canReadMemories),
  write: yesNo(a.canWriteMemories),
  collections: a.readCollectionIds.join(","),
});

const list = Command.make(
  "list",
  {
    revoked: Flag.Boolean("revoked").pipe(
      Flag.withDescription("Show revoked agents instead of live ones"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ revoked }) {
    const { flags, api } = yield* session;
    const { agents } = yield* api.run((rf) =>
      rf.agents.list({ status: revoked ? "revoked" : "active" }),
    );
    yield* print(
      agents,
      () =>
        agents.length === 0
          ? revoked
            ? "No revoked agents."
            : "No agents. Create one with `rf agents create <name>`."
          : table(agents.map(agentRow), [
              "id",
              "name",
              "read",
              "write",
              "collections",
            ]),
      flags.json,
    );
  }),
).pipe(Command.withDescription("List agents"));

const collectionsFlag = Flag.String("collections").pipe(
  Flag.withDescription("Collection ids the agent may use, comma-separated"),
  Flag.optional,
);

const create = Command.make(
  "create",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription('A name such as "claude-code"'),
    ),
    readOnly: Flag.Boolean("read-only").pipe(
      Flag.withDescription("Let the agent read but not write"),
      Flag.withDefault(false),
    ),
    collections: collectionsFlag,
    use: Flag.Boolean("use").pipe(
      Flag.withDescription(
        "Also mint a key for the agent, store it, and make Claude Code and its hooks act as it in this project",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ name, readOnly, collections, use }) {
    const { flags, environment, settings, api } = yield* session;
    // Without a list, the account's default collection, which is what the
    // bootstrap script gave the first agent.
    let ids = commaList(Option.getOrUndefined(collections));
    if (!ids) {
      const me = yield* api.run((rf) => rf.me.get());
      const def = me.collections.find((c) => c.isDefault)?.id;
      if (!def) {
        yield* Console.error(
          "The account has no default collection; pass --collections.",
        );
        process.exitCode = 1;
        return;
      }
      ids = [def];
    }
    const agent = yield* api.run((rf) =>
      rf.agents.create({
        name,
        canReadMemories: true,
        canWriteMemories: !readOnly,
        readCollectionIds: ids,
        writeCollectionIds: readOnly ? [] : ids,
      }),
    );
    const key = use
      ? yield* api.run((rf) =>
          rf.keys.create({
            name: `${name} on this machine`,
            agentId: agent.id,
          }),
        )
      : null;
    if (key) yield* storeAgentKey(environment, agent.id, key);
    yield* print(
      key ? { agent, key } : agent,
      () =>
        [
          `Created agent ${agent.id} (${agent.name}): ${readOnly ? "read-only" : "read and write"} on ${ids.join(", ")}.`,
          ...(key
            ? [
                `Key ${key.keyPrefix}… stored, and rf.json now names this agent. Shown once:`,
                "",
                `  ${key.apiKey ?? ""}`,
                "",
                AGENT_HERE,
              ]
            : [
                `Mint a key for it with \`rf keys create --name <name> --agent ${agent.id}\`.`,
              ]),
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Create an agent"));

const edit = Command.make(
  "edit",
  {
    id: Argument.String("id"),
    name: Flag.String("name").pipe(Flag.optional),
    readOnly: Flag.Boolean("read-only").pipe(Flag.withDefault(false)),
    readWrite: Flag.Boolean("read-write").pipe(Flag.withDefault(false)),
    collections: collectionsFlag,
  },
  Effect.fn(function* ({ id, name, readOnly, readWrite, collections }) {
    const { flags, api } = yield* session;
    if (readOnly && readWrite) {
      yield* Console.error("Pass --read-only or --read-write, not both.");
      process.exitCode = 1;
      return;
    }
    const current = (yield* api.run((rf) =>
      rf.agents.list({ status: "active" }),
    )).agents.find((a) => a.id === id);
    if (!current) {
      yield* Console.error(`No live agent ${id}. See \`rf agents list\`.`);
      process.exitCode = 1;
      return;
    }
    const ids = commaList(Option.getOrUndefined(collections));
    const canWrite = readWrite
      ? true
      : readOnly
        ? false
        : current.canWriteMemories;
    const readIds = ids ?? current.readCollectionIds;
    const patch = {
      ...(Option.isSome(name) ? { name: name.value } : {}),
      ...(readOnly || readWrite ? { canWriteMemories: canWrite } : {}),
      ...(ids ? { readCollectionIds: ids } : {}),
      ...(ids || readOnly || readWrite
        ? { writeCollectionIds: canWrite ? readIds : [] }
        : {}),
    };
    if (Object.keys(patch).length === 0) {
      yield* Console.error(
        "Nothing to change; pass --name, --read-only, --read-write, or --collections.",
      );
      process.exitCode = 1;
      return;
    }
    const agent = yield* api.run((rf) => rf.agents.update(id, patch));
    yield* print(
      agent,
      () =>
        table(
          [agentRow(agent)],
          ["id", "name", "read", "write", "collections"],
        ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Change an agent's name or permissions"));

const revoke = Command.make(
  "revoke",
  { id: Argument.String("id") },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const result = yield* api.run((rf) => rf.agents.revoke(id));
    yield* print(
      result,
      () =>
        `Revoked agent ${result.agent.id} (${result.agent.name}) and ${result.keysRevoked} of its ${result.keysRevoked === 1 ? "key" : "keys"}.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Revoke an agent and every key it holds"));

export const agents = Command.make("agents").pipe(
  Command.withSubcommands([list, create, edit, revoke]),
  Command.withDescription("Agents: list, create, edit, revoke"),
);
