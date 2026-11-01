import {
  createClient,
  RentfreeError,
  RentfreeUnreachable,
  type Client,
} from "@rentfree/sdk";
import { Context, Effect, Layer, Schema } from "effect";
import pkg from "../package.json" with { type: "json" };
import { agentCallerReason, type Settings } from "./config";
import { Platform } from "./platform";

/**
 * The api answered with an error body: `{ error, issues? }`. `hint` is the
 * CLI's own word on why, such as whose key was refused.
 */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
  error: Schema.String,
  issues: Schema.Array(
    Schema.Struct({ path: Schema.String, message: Schema.String }),
  ),
  hint: Schema.optional(Schema.String),
}) {}

/** There is no key to send, or the api refused the one there was. */
export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()(
  "NotLoggedIn",
  {},
) {}

/** The request never got an answer. */
export class ApiUnreachable extends Schema.TaggedError<ApiUnreachable>()(
  "ApiUnreachable",
  {
    url: Schema.String,
    detail: Schema.String,
  },
) {}

export type ApiFailure = ApiError | NotLoggedIn | ApiUnreachable;

/**
 * How requests leave the machine. The live one is the platform's `fetch`;
 * tests provide one that answers from a table.
 */
export class Fetch extends Context.Service<Fetch, typeof globalThis.fetch>()(
  "rf/Fetch",
) {
  static readonly live = Layer.succeed(Fetch, (input, init) =>
    globalThis.fetch(input, init),
  );
}

/**
 * The api as a command sees it: SDK calls, run as effects whose failures
 * are the three a command can explain. The SDK does the requests, keys,
 * and idempotency; this adapter holds no logic of its own.
 *
 * ```ts
 * const { keys } = yield* api.run((rf) => rf.keys.list());
 * ```
 */
export interface Api {
  run<A>(call: (rf: Client) => Promise<A>): Effect.Effect<A, ApiFailure>;
}

export const makeApi = (
  settings: Settings,
  { anonymous = false }: { anonymous?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fetch = yield* Fetch;
    const platform = yield* Platform;
    const rf = createClient({
      apiKey: settings.apiKey,
      baseUrl: `${settings.apiUrl}/api`,
      fetch,
      headers: { "user-agent": `rf/${pkg.version}` },
      // The SDK's waits pause through the platform, so tests wait no time.
      sleep: (ms) => Effect.runPromise(platform.sleep(ms)),
    });
    const api: Api = {
      run: (call) =>
        // A login starts with no key; everything else needs one.
        !settings.apiKey && !anonymous
          ? Effect.fail(new NotLoggedIn())
          : Effect.tryPromise({
              try: () => call(rf),
              catch: (error) => failureOf(error, settings),
            }),
    };
    return api;
  });

/**
 * Why a key was refused, when the CLI can say more than the api: the key
 * was an agent's. It never suggests a way round the refusal, since the
 * reader may be the agent itself.
 */
export function refusalHint(settings: Settings): string | undefined {
  if (settings.keySource === "agent" && settings.agentCaller) {
    const agent = settings.project?.agentId ?? "the project's agent";
    return `rf used the key of agent ${agent}, which ${settings.projectFile ?? "rf.json"} names, because ${agentCallerReason[settings.agentCaller]}; that agent may not do this. It takes your own login, from a terminal of your own.`;
  }
  if (settings.keySource === "env") {
    return "The key in RF_API_KEY may be an agent's, which may not do this; `rf whoami` says whose it is.";
  }
  return undefined;
}

/** An SDK error as one of the CLI's failures. */
function failureOf(error: unknown, settings: Settings): ApiFailure {
  if (error instanceof RentfreeError) {
    if (error.status === 401) return new NotLoggedIn();
    const hint = error.status === 403 ? refusalHint(settings) : undefined;
    return new ApiError({
      status: error.status,
      error: error.code,
      issues: [...error.issues],
      ...(hint && { hint }),
    });
  }
  if (error instanceof RentfreeUnreachable) {
    const cause = error.cause;
    return new ApiUnreachable({
      url: settings.apiUrl,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  // Anything else is a fault in the client, reported as such, not as the user's.
  return new ApiError({
    status: 0,
    error: "client_error",
    issues: [
      {
        path: "",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}

/** One line a person can act on, for each failure. */
export function describeFailure(failure: ApiFailure): string {
  switch (failure._tag) {
    case "NotLoggedIn":
      return "Not logged in. Run `rf init`, or set RF_API_KEY.";
    case "ApiUnreachable":
      return `Could not reach the api at ${failure.url}: ${failure.detail}`;
    case "ApiError": {
      const detail = failure.issues.map((i) =>
        i.path ? `${i.path}: ${i.message}` : i.message,
      );
      const line = detail.length
        ? `The api refused the request (${failure.error}): ${detail.join("; ")}`
        : `The api refused the request (${failure.error}, HTTP ${failure.status}).`;
      return failure.hint ? `${line} ${failure.hint}` : line;
    }
  }
}
