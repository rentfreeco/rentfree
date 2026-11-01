import { Console, Effect, Option } from "effect";
import { Flag } from "effect/cli";
import { makeApi, type Api } from "../client";
import { realEnvironment, resolveSettings, type Settings } from "../config";
import { Platform } from "../platform";
import { root } from "../root";

const sessionFor = (asAgent: boolean) =>
  Effect.gen(function* () {
    const flags = yield* root;
    const environment = realEnvironment();
    const settings = yield* resolveSettings(environment, { ...flags, asAgent });
    const api = yield* makeApi(settings);
    return { flags, environment, settings, api };
  });

/** What every account command starts from: the flags, the machine, the settings, the api. */
export const session = sessionFor(false);

/** The same, for what only an agent runs, a hook: the project's agent key whatever the environment says. */
export const agentSession = sessionFor(true);

/** Who acts as the agent rf.json names, said once a project names one. */
export const AGENT_HERE =
  "Claude Code, its hooks, and anything run with RF_AGENT=1 act as it here; in your own terminal you keep your login.";

/** A comma-separated flag value as a list, or none. */
export const commaList = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

/** The api's records, as the SDK's contract types them. */
export type { Agent, Collection, CreatedKey, Key, Me } from "@rentfree/sdk";

/** `yes` or `no`, for a permission column. */
export const yesNo = (value: boolean) => (value ? "yes" : "no");

/** A flag for the collection a command works in. */
export const collectionFlag = Flag.String("collection").pipe(
  Flag.withDescription(
    "The collection to use; otherwise rf.json's, then the account's default",
  ),
  Flag.optional,
);

/**
 * The collection a command works in: the flag, else the project's rf.json,
 * else the default the login recorded, else the account's default as the
 * api reports it. Null, with the reason on stderr and exit code 1, when
 * there is none.
 */
export const collectionFor = (
  flag: Option.Option<string>,
  { settings, api }: { settings: Settings; api: Api },
) =>
  Effect.gen(function* () {
    const chosen =
      Option.getOrUndefined(flag) ??
      settings.project?.collectionId ??
      settings.defaultCollectionId;
    if (chosen) return chosen;
    // A key from RF_API_KEY has no login to remember a default; ask.
    const me = yield* api.run((rf) => rf.me.get());
    const fallback = me.collections.find((c) => c.isDefault)?.id;
    if (fallback) return fallback;
    yield* Console.error(
      "No collection to use. Pass --collection, or run `rf config set collection <id>`.",
    );
    process.exitCode = 1;
    return null;
  });

/** Text from an argument, or everything on stdin when the argument is `-`. */
export const textFrom = (value: string) =>
  Effect.gen(function* () {
    if (value !== "-") return value;
    const platform = yield* Platform;
    return (yield* platform.readStdin).replace(/\n$/, "");
  });

/** Text on one line, cut to `max` characters, for a row in a list. */
export const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
