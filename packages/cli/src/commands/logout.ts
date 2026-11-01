import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import { makeApi } from "../client";
import { readCredentials, realEnvironment, writeCredentials } from "../config";
import { print } from "../output";
import { root } from "../root";

/**
 * `rf logout`: revokes the stored key through the api, then forgets it.
 * If the api cannot be reached, or the key already stopped working, the
 * local copy still goes, and the message says the key may be live.
 */
export const logout = Command.make(
  "logout",
  {},
  Effect.fn(function* () {
    const flags = yield* root;
    const environment = realEnvironment();
    const credentials = yield* readCredentials(environment);
    const profile = credentials.profiles[flags.profile];
    if (!profile) {
      yield* Console.log("No login stored.");
      return;
    }

    const api = yield* makeApi({
      apiUrl: profile.apiUrl,
      apiKey: profile.apiKey,
      keySource: "profile",
      agentCaller: null,
      profile: flags.profile,
      project: null,
      projectFile: null,
      defaultCollectionId: profile.defaultCollectionId,
    });
    const revoked = yield* api
      .run(async (rf) => {
        const me = await rf.me.get();
        await rf.keys.revoke(me.caller.apiKeyId);
        return true;
      })
      .pipe(Effect.orElseSucceed(() => false));

    delete credentials.profiles[flags.profile];
    yield* writeCredentials(environment, credentials);
    yield* print(
      { revoked, keyPrefix: profile.keyPrefix },
      () =>
        revoked
          ? `Logged out. Key ${profile.keyPrefix}… revoked.`
          : `Logged out locally, but key ${profile.keyPrefix}… could not be revoked and may still be live. Revoke it with \`rf keys revoke\` once the api is reachable.`,
      flags.json,
    );
  }),
).pipe(Command.withDescription("Revoke the stored key and forget it"));
