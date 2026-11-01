import { Effect } from "effect";
import { Command } from "effect/cli";
import { makeApi } from "../client";
import { keyOrigin, realEnvironment, resolveSettings } from "../config";
import { indent, kv, print, table } from "../output";
import { root } from "../root";

export const whoami = Command.make(
  "whoami",
  {},
  Effect.fn(function* () {
    const flags = yield* root;
    const settings = yield* resolveSettings(realEnvironment(), flags);
    const api = yield* makeApi(settings);
    const me = yield* api.run((rf) => rf.me.get());
    yield* print(
      me,
      () =>
        [
          kv([
            ["user", `${me.user.id}  ${me.user.email ?? "-"}`],
            [
              "key",
              `${me.caller.keyName ?? "-"}  ${me.caller.keyPrefix ?? "-"}  ${
                me.caller.agentId ? `agent ${me.caller.agentId}` : "user-level"
              } (${keyOrigin(settings)})`,
            ],
            ["api", settings.apiUrl],
            [
              "model",
              me.user.embedDimensions
                ? `${me.user.embedModel}@${me.user.embedDimensions}`
                : me.user.embedModel,
            ],
          ]),
          "collections",
          indent(
            table(
              me.collections.map((c) => ({
                ...c,
                default: c.isDefault ? "default" : "",
              })),
              ["id", "name", "default"],
            ),
          ),
          ...(me.agents
            ? ["agents", indent(table(me.agents, ["id", "name"]))]
            : []),
        ].join("\n"),
      flags.json,
    );
  }),
).pipe(
  Command.withDescription(
    "Who the current key belongs to, and what it can see",
  ),
);
