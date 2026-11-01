import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { readCredentials, writeCredentials } from "../config";
import { print } from "../output";
import { session } from "./shared";

const del = Command.make(
  "delete",
  {
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription("The account's email, typed back, to confirm"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ confirm }) {
    const { flags, environment, api } = yield* session;
    const me = yield* api.run((rf) => rf.me.get());
    const expected = me.user.email ?? me.user.id;
    if (Option.getOrUndefined(confirm) !== expected) {
      // Spelled out rather than asked interactively, so a script or an
      // agent can never answer it by accident.
      yield* Console.error(
        `This deletes the account ${expected} and everything in it: every collection, memory, source, agent, and key. It cannot be undone.\nTo go ahead: rf account delete --confirm ${expected}`,
      );
      process.exitCode = 1;
      return;
    }
    const gone = yield* api.run((rf) => rf.me.delete());
    const credentials = yield* readCredentials(environment);
    delete credentials.profiles[flags.profile];
    yield* writeCredentials(environment, credentials);
    yield* print(
      gone,
      () =>
        `Deleted the account ${expected}. Every key stopped working; the login here is forgotten.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Delete the account and everything in it"));

export const account = Command.make("account").pipe(
  Command.withSubcommands([del]),
  Command.withDescription("The account itself"),
);
