import type { LoginStarted } from "@rentfree/sdk";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { banner, styleFor } from "../banner";
import { makeApi, type Api } from "../client";
import {
  credentialsPath,
  readCredentials,
  realEnvironment,
  resolveSettings,
  writeCredentials,
  type Profile,
} from "../config";
import { KEY_PREFIX_LENGTH, maskKey, print } from "../output";
import { Platform, type Menu } from "../platform";
import { root } from "../root";

/** Why an init did not end with a key, in the user's terms. */
const refusals: Record<string, string> = {
  denied: "The login was denied in the browser.",
  expired: "The code expired before it was approved. Run `rf init` again.",
  no_key: "No key was entered, so nothing was stored.",
  bad_key: "The api did not accept that key, so nothing was stored.",
  cancelled: "Cancelled; nothing was stored.",
};

/** A login that worked: the profile to store, and its default collection's name if known. */
interface SignedIn {
  readonly profile: Profile;
  readonly collection: string | null;
}

type Settings = Parameters<typeof makeApi>[0];
type Style = ReturnType<typeof styleFor>;

/** How progress is told: a step starting, and the lines under it. */
interface Say {
  readonly step: (line: string) => Effect.Effect<void>;
  readonly detail: (line: string) => Effect.Effect<void>;
}

/**
 * `rf init`, which `rf login` still runs. A person at a terminal gets a
 * banner and a choice: log in through the browser, the device flow, or
 * type a key in. The device flow: the api hands out a code, the browser is
 * sent to the web app to approve it, and the CLI polls until it gets a
 * key, which it stores as the profile. A typed key is checked against the
 * api before it is stored. A pipe or `--json` is asked nothing and goes to
 * the browser, as a script expects; a machine with no browser at all sets
 * `RF_API_KEY` instead, which every command honours.
 * A login already stored for the profile is kept unless the person agrees
 * to replace it, or `--force` is given.
 */
export const init = Command.make(
  "init",
  {
    force: Flag.Boolean("force").pipe(
      Flag.withDescription(
        "Replace a login already stored for this profile without asking",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ force }) {
    const flags = yield* root;
    const environment = realEnvironment();
    const settings = yield* resolveSettings(environment, flags);
    const platform = yield* Platform;
    const terminal = platform.terminal;
    const s = styleFor(terminal);
    // Someone is reading, so the output can be laid out for them.
    const person = !flags.json && terminal.interactive;

    // A login already stored for this profile is replaced only when the
    // person says so, or --force does; nobody asked means no.
    const stored = (yield* readCredentials(environment)).profiles[
      flags.profile
    ];
    if (stored && !force) {
      if (!(person && terminal.canAsk)) {
        yield* Console.error(
          `A login is already stored for profile ${flags.profile} (${describeStored(stored)}). Pass --force to replace it.`,
        );
        process.exitCode = 1;
        return;
      }
      const replace = yield* askToReplace(stored, flags.profile, platform, s);
      if (replace === null) {
        yield* Console.error(refusals.cancelled!);
        process.exitCode = 130;
        return;
      }
      if (!replace) {
        yield* Console.log(
          s.step("Cancelled. Use --force to skip this check."),
        );
        return;
      }
    }
    // Progress goes to stderr under --json, so stdout stays the one object.
    const say: Say = flags.json
      ? { step: Console.error, detail: Console.error }
      : person
        ? {
            step: (line) => Console.log(`\n${s.step(line)}`),
            detail: (line) => Console.log(`  ${line}`),
          }
        : { step: Console.log, detail: Console.log };

    if (person) {
      yield* Console.log(banner(terminal));
      yield* Console.log(`\n${s.step("Welcome! Let's set up rf.")}`);
    }

    const method =
      person && terminal.canAsk
        ? yield* chooseMethod(platform, s)
        : ("browser" as const);

    const signedIn: SignedIn | string =
      method === null
        ? "cancelled"
        : method === "key"
          ? yield* typedKey(settings, platform, s, say)
          : yield* throughBrowser(settings, platform, say);
    if (typeof signedIn === "string") {
      yield* Console.error(refusals[signedIn] ?? signedIn);
      process.exitCode = signedIn === "cancelled" ? 130 : 1;
      return;
    }
    const { profile, collection } = signedIn;

    const credentials = yield* readCredentials(environment);
    credentials.profiles[flags.profile] = profile;
    yield* writeCredentials(environment, credentials);
    const file = yield* credentialsPath(environment);
    const defaultCollection = profile.defaultCollectionId
      ? collection
        ? `${collection} (${profile.defaultCollectionId})`
        : profile.defaultCollectionId
      : null;
    const done = [
      `Logged in as ${profile.email ?? profile.userId}`,
      `API key ${profile.keyPrefix}… saved in ${file}`,
      ...(defaultCollection
        ? [`Default collection: ${defaultCollection}`]
        : []),
    ].map(s.done);
    yield* print(
      {
        userId: profile.userId,
        email: profile.email,
        keyPrefix: profile.keyPrefix,
        apiUrl: profile.apiUrl,
        defaultCollectionId: profile.defaultCollectionId,
        credentialsPath: file,
      },
      () =>
        person ? ["", ...done, "", getStarted(s)].join("\n") : done.join("\n"),
      flags.json,
    );
  }),
).pipe(
  Command.withAlias("login"),
  Command.withDescription(
    "Set up rf: sign in through the browser, or with a key; a first sign-in is a sign-up",
  ),
);

/** A stored login in a few words: whose it is, and its key's public prefix. */
const describeStored = (stored: Profile) =>
  [stored.email, `API key: ${stored.keyPrefix}…`].filter(Boolean).join(", ");

/**
 * Asks whether to replace the login stored for `profile`, no unless the
 * answer is yes. Null if the person leaves.
 */
const askToReplace = (
  stored: Profile,
  profile: string,
  platform: Platform["Service"],
  s: Style,
) =>
  Effect.gen(function* () {
    const found =
      profile === "default"
        ? "Existing configuration found"
        : `Existing configuration found for profile ${profile}`;
    yield* Console.log(
      `\n  ${s.face(found)} ${s.dim(`(${describeStored(stored)})`)}`,
    );
    const answer = yield* platform.ask(
      "  Overwrite existing config? This cannot be undone. [y/N] ",
    );
    return answer === null ? null : /^y(es)?$/i.test(answer.trim());
  });

/** The ways in, the browser first. */
const METHODS = [
  { method: "browser", label: "Login with email", note: "(recommended)" },
  { method: "key", label: "Enter API key manually", note: null },
] as const;

/**
 * The menu of ways in, with the highlighted one marked. Once chosen, it
 * folds to one line naming the choice.
 */
const authMenu = (s: Style): Menu => {
  const question = `  ${s.face("How would you like to authenticate?")}`;
  return {
    count: METHODS.length,
    render: (cursor, chosen) =>
      chosen
        ? `${question} ${METHODS[cursor]!.label}`
        : [
            question,
            ...METHODS.map(({ label, note }, i) => {
              const rest = note ? ` ${s.dim(note)}` : "";
              return i === cursor
                ? `  ${s.face(`❯ ${label}`)}${rest}`
                : `    ${label}${rest}`;
            }),
            `  ${s.dim("↑/↓ to move, enter to choose")}`,
          ].join("\n"),
  };
};

/** The way in, asked of a person: the browser by default, or a key. Null if they leave. */
const chooseMethod = (platform: Platform["Service"], s: Style) =>
  Effect.gen(function* () {
    yield* Console.log("");
    const chosen = yield* platform.choose(authMenu(s));
    return chosen === null ? null : METHODS[chosen]!.method;
  });

/** What to try first, for someone who has just logged in. */
const getStarted = (s: Style) =>
  s.dim(
    [
      "  Get started:",
      `    rf remember "I prefer dark mode"`,
      `    rf search "preferences"`,
      "    rf hooks install    # in a project, so Claude Code remembers too",
    ].join("\n"),
  );

/**
 * A key typed or pasted at a prompt that shows its prefix and an asterisk
 * for each of the rest. It is stored only once the api has answered
 * `GET /me` with it, which also says whose it is.
 */
const typedKey = (
  settings: Settings,
  platform: Platform["Service"],
  s: Style,
  say: Say,
) =>
  Effect.gen(function* () {
    yield* Console.log("");
    const answer = yield* platform.ask(`  ${s.face("API key")}: `, {
      show: maskKey,
    });
    if (answer === null) return "cancelled";
    const apiKey = answer.trim();
    if (!apiKey) return "no_key";
    yield* say.step("Checking the key...");
    const api = yield* makeApi({ ...settings, apiKey });
    const me = yield* api
      .run((rf) => rf.me.get())
      .pipe(Effect.catchTag("NotLoggedIn", () => Effect.succeed(null)));
    if (!me) return "bad_key";
    const collection = me.collections.find((c) => c.isDefault) ?? null;
    return {
      profile: {
        apiUrl: settings.apiUrl,
        apiKey,
        keyPrefix: apiKey.slice(0, KEY_PREFIX_LENGTH),
        userId: me.user.id,
        email: me.user.email,
        defaultCollectionId: collection?.id ?? null,
      },
      collection: collection?.name ?? null,
    } satisfies SignedIn;
  });

const throughBrowser = (
  settings: Settings,
  platform: Platform["Service"],
  say: Say,
) =>
  Effect.gen(function* () {
    const api = yield* makeApi(
      { ...settings, apiKey: null },
      { anonymous: true },
    );
    const start = yield* api.run((rf) =>
      rf.login.start({ name: `CLI on ${platform.hostname}` }),
    );
    const opened = yield* platform.openBrowser(start.verifyUrl);
    yield* say.step(
      opened
        ? `Opening ${start.verifyUrl} in your browser.`
        : `Open ${start.verifyUrl} in your browser.`,
    );
    yield* say.detail(
      `If it did not open, visit that address and enter ${start.userCode}.`,
    );
    yield* say.detail("Waiting for approval...");
    const outcome = yield* poll(api, platform, start);
    if (typeof outcome === "string") return outcome;
    return {
      profile: {
        apiUrl: settings.apiUrl,
        apiKey: outcome.apiKey,
        keyPrefix: outcome.keyPrefix,
        userId: outcome.user.id,
        email: outcome.user.email,
        defaultCollectionId: outcome.defaultCollectionId,
      },
      collection: yield* collectionName(
        settings,
        outcome.apiKey,
        outcome.defaultCollectionId,
      ),
    } satisfies SignedIn;
  });

/**
 * The name of the collection a new key defaults to, asked with that key.
 * Only for show, so a failure leaves the id to stand for it.
 */
const collectionName = (
  settings: Settings,
  apiKey: string,
  collectionId: string | null,
) =>
  collectionId === null
    ? Effect.succeed(null)
    : makeApi({ ...settings, apiKey }).pipe(
        Effect.flatMap((api) => api.run((rf) => rf.me.get())),
        Effect.map(
          (me) => me.collections.find((c) => c.id === collectionId)?.name,
        ),
        Effect.map((name) => name ?? null),
        Effect.orElseSucceed(() => null),
      );

/**
 * Asks every `interval` seconds until the browser answers or the session
 * expires. A `slow_down` adds five seconds, as the device flow prescribes.
 */
const poll = (api: Api, platform: Platform["Service"], start: LoginStarted) =>
  Effect.gen(function* () {
    let interval = start.interval * 1000;
    let waited = 0;
    while (waited < start.expiresIn * 1000) {
      yield* platform.sleep(interval);
      waited += interval;
      const answer = yield* api
        .run((rf) => rf.login.poll(start.deviceCode))
        .pipe(
          Effect.catchTag("ApiError", (error) =>
            error.error === "slow_down" ||
            error.error === "access_denied" ||
            error.error === "device_session_expired"
              ? Effect.succeed(error.error)
              : Effect.fail(error),
          ),
        );
      if (typeof answer === "string") {
        if (answer === "access_denied") return "denied" as const;
        if (answer === "device_session_expired") return "expired" as const;
        interval += 5000; // slow_down
        continue;
      }
      if (answer.status === "approved") return answer;
    }
    return "expired" as const;
  });
