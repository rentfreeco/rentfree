import type { RecapRun } from "@rentfree/sdk";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { kv, print, table } from "../output";
import { session } from "./shared";

const cost = (run: RecapRun) =>
  run.costUsd === null ? "-" : `$${run.costUsd.toFixed(4)}`;

/** What a run decided, such as "2 created, 1 updated", from its stats. */
const decided = (run: RecapRun) => {
  const parts = ["created", "updated", "confirmed", "invalidated"]
    .map((k) => [k, run.stats[k]] as const)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? parts.join(", ") : "nothing new";
};

const summary = (run: RecapRun) =>
  `Recap ${run.id} ${run.status}: ${decided(run)}; events ${run.eventsFromId + 1} to ${run.eventsToId}; ${cost(run)}.${
    run.error ? ` ${run.error}` : ""
  }`;

const run = Command.make(
  "run",
  {
    wait: Flag.Boolean("wait").pipe(
      Flag.withDescription("Wait for the run to finish, and print what it did"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ wait }) {
    const { flags, api } = yield* session;
    if (wait) {
      const finished = yield* api.run((rf) => rf.recap.runAndWait());
      if (finished?.status === "failed") process.exitCode = 1;
      yield* print(
        finished,
        () => (finished ? summary(finished) : "Nothing to recap."),
        flags.json,
      );
      return;
    }
    const asked = yield* api.run((rf) => rf.recap.run());
    yield* print(
      asked,
      () =>
        asked.status === "started"
          ? `Started a recap of ${asked.unread} unread events.`
          : asked.status === "running"
            ? `A recap is already running: ${asked.run.id}.`
            : "Nothing to recap.",
      flags.json,
    );
  }),
).pipe(Command.withDescription("Recap the events not yet read"));

const runs = Command.make(
  "runs",
  {
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Most to show, 1 to 100"),
      Flag.withDefault(10),
    ),
  },
  Effect.fn(function* ({ limit }) {
    const { flags, api } = yield* session;
    const { runs: found } = yield* api.run((rf) => rf.recap.runs({ limit }));
    yield* print(
      found,
      () =>
        found.length === 0
          ? "No recap runs yet."
          : table(
              found.map((r) => ({
                id: r.id,
                trigger: r.trigger,
                status: r.status,
                decided: decided(r),
                cost: cost(r),
                started: r.startedAt,
              })),
              ["id", "trigger", "status", "decided", "cost", "started"],
            ),
      flags.json,
    );
  }),
).pipe(Command.withDescription("Recap runs, newest first"));

const show = Command.make(
  "show",
  {
    id: Argument.String("id").pipe(Argument.withDescription("The run's id")),
  },
  Effect.fn(function* ({ id }) {
    const { flags, api } = yield* session;
    const r = yield* api.run((rf) => rf.recap.get(id));
    yield* print(
      r,
      () =>
        kv([
          ["id", r.id],
          ["status", r.error ? `${r.status}: ${r.error}` : r.status],
          ["trigger", r.trigger],
          ["decided", decided(r)],
          ["events", `${r.eventsFromId + 1} to ${r.eventsToId}`],
          ["models", [r.extractModel, r.reconcileModel].filter(Boolean)],
          ["tokens", `${r.inputTokens ?? 0} in, ${r.outputTokens ?? 0} out`],
          ["cost", cost(r)],
          ["started", r.startedAt],
          ["finished", r.finishedAt],
        ]),
      flags.json,
    );
  }),
).pipe(Command.withDescription("One recap run"));

export const recap = Command.make("recap").pipe(
  Command.withSubcommands([run, runs, show]),
  Command.withDescription("Recap: run, runs, show"),
);
