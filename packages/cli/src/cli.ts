import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import pkg from "../package.json" with { type: "json" };
import { describeFailure, type ApiFailure } from "./client";
import { account } from "./commands/account";
import { agents } from "./commands/agents";
import { collections } from "./commands/collections";
import { config } from "./commands/config";
import { hooks } from "./commands/hooks";
import { keys } from "./commands/keys";
import { init } from "./commands/init";
import { logout } from "./commands/logout";
import { memories, remember } from "./commands/memories";
import { recap } from "./commands/recap";
import { log, sessionCommand } from "./commands/sessions";
import { sources } from "./commands/sources";
import { context, profile, search } from "./commands/recall";
import { whoami } from "./commands/whoami";
import { root } from "./root";

export const VERSION: string = pkg.version;

/** `rf` with every subcommand attached. */
export const cli = root.pipe(
  Command.withSubcommands([
    init,
    logout,
    whoami,
    context,
    search,
    remember,
    memories,
    profile,
    sessionCommand,
    log,
    sources,
    recap,
    hooks,
    keys,
    agents,
    collections,
    config,
    account,
  ]),
);

/**
 * An api failure is the command's answer, not a crash: one line on stderr
 * and exit code 1, with no stack trace. Parse errors and help are the CLI
 * library's own and keep its behaviour.
 */
export const reportFailure = (failure: ApiFailure) =>
  Console.error(describeFailure(failure)).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

/** Runs `rf` with explicit arguments, which tests use. */
export const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: VERSION })(args).pipe(
    Effect.catchTags({
      ApiError: reportFailure,
      NotLoggedIn: reportFailure,
      ApiUnreachable: reportFailure,
    }),
  );
