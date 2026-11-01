import { Command, Flag } from "effect/cli";

/**
 * The `rf` command itself: no action of its own, only the flags every
 * subcommand shares. Subcommands read them by yielding this command.
 */
export const root = Command.make("rf").pipe(
  Command.withSharedFlags({
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print JSON instead of text, for scripts"),
      Flag.withDefault(false),
    ),
    apiUrl: Flag.String("api-url").pipe(
      Flag.withDescription(
        "The api to talk to; otherwise RF_API_URL, then the address stored at login",
      ),
      Flag.optional,
    ),
    profile: Flag.String("profile").pipe(
      Flag.withDescription("Which stored login to use"),
      Flag.withDefault("default"),
    ),
  }),
  Command.withDescription(
    "rentfree: memory for AI agents, from the terminal. Run `rf init` first.",
  ),
);
