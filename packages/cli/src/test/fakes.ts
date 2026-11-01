import { Console, Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fetch } from "../client";
import type { Environment } from "../config";
import { Platform, type Terminal } from "../platform";

/** A request the fake api saw. */
export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** One canned answer, chosen by method and path. `respond` may vary it by how many times it was used. */
export interface Canned {
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
  respond?: (call: number) => { status?: number; body?: unknown };
}

/**
 * A `fetch` that answers from a table and records what it was asked, so a
 * command's requests can be asserted without a network. The SDK makes the
 * requests; this is where they land.
 */
export function fakeApi(answers: ReadonlyArray<Canned>) {
  const seen: Seen[] = [];
  const calls = new Map<Canned, number>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    seen.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: text ? parseOrText(text) : null,
    });
    const answer = answers.find(
      (a) => a.path === url.pathname && (a.method ?? "GET") === request.method,
    );
    const call = calls.get(answer!) ?? 0;
    if (answer) calls.set(answer, call + 1);
    const varied = answer?.respond?.(call);
    const status = varied?.status ?? answer?.status ?? (answer ? 200 : 404);
    const body =
      varied?.body ?? answer?.body ?? (answer ? {} : { error: "not_found" });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { layer: Layer.succeed(Fetch, fetch), seen, fetch };
}

/** A question the fake terminal was asked, and what it showed of the answer once typed. */
export interface Asked {
  question: string;
  shown: string | null;
}

/**
 * A machine that waits no time, opens no browser, and has a chosen stdin.
 * stdout is a pipe unless a terminal is given, as it is when a model runs
 * `rf`. Questions and menus take `answers` in order, a string for a
 * question and the index chosen for a menu; past the last, or on the
 * wrong kind, the person has pressed ctrl-C. A menu is kept as drawn
 * first and, once chosen, as it folds.
 */
export function fakePlatform(
  options: {
    stdin?: string;
    opener?: boolean;
    terminal?: Terminal;
    answers?: ReadonlyArray<string | number>;
  } = {},
) {
  const opened: string[] = [];
  const slept: number[] = [];
  const asked: Asked[] = [];
  const menus: string[] = [];
  let next = 0;
  const layer = Layer.succeed(Platform, {
    ask: (question, { show = (typed: string) => typed } = {}) =>
      Effect.sync(() => {
        const answer = options.answers?.[next++];
        const typed = typeof answer === "string" ? answer : null;
        asked.push({ question, shown: typed === null ? null : show(typed) });
        return typed;
      }),
    choose: ({ count, render }) =>
      Effect.sync(() => {
        menus.push(render(0, false));
        const answer = options.answers?.[next++];
        if (typeof answer !== "number" || answer >= count) return null;
        menus.push(render(answer, true));
        return answer;
      }),
    hostname: "test-host",
    openBrowser: (url) =>
      Effect.sync(() => {
        opened.push(url);
        return options.opener ?? true;
      }),
    sleep: (ms) =>
      Effect.sync(() => {
        slept.push(ms);
      }),
    readStdin: Effect.succeed(options.stdin ?? ""),
    terminal: options.terminal ?? {
      interactive: false,
      canAsk: false,
      columns: 80,
      color: "none",
    },
  });
  return { layer, opened, slept, asked, menus };
}

/** A console that collects what was printed instead of printing it. */
export function fakeConsole() {
  const out: string[] = [];
  const err: string[] = [];
  const console: Console.Console = {
    ...globalThis.console,
    log: (...args) => out.push(args.map(String).join(" ")),
    error: (...args) => err.push(args.map(String).join(" ")),
  };
  return {
    out,
    err,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Console.Console, console),
  };
}

/** A temporary home directory, and an `Environment` that lives in it. */
export async function temporaryHome(
  env: Record<string, string | undefined> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "rf-test-"));
  const environment: Environment = {
    env: { XDG_CONFIG_HOME: join(home, ".config"), ...env },
    cwd: home,
    home,
  };
  return {
    home,
    environment,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

/**
 * Runs `rf` the way `main` does, against the fake api and machine, with the
 * console captured and the exit code read back and restored.
 */
export async function runRf(
  args: ReadonlyArray<string>,
  answers: ReadonlyArray<Canned>,
  platformOptions: Parameters<typeof fakePlatform>[0] = {},
) {
  const { runCli } = await import("../cli");
  const { NodeServices } = await import("@effect/platform-node");
  const fake = fakeApi(answers);
  const platform = fakePlatform(platformOptions);
  const console = fakeConsole();
  const exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  try {
    await Effect.runPromise(
      console.provide(
        Effect.provide(
          runCli(args),
          Layer.mergeAll(NodeServices.layer, fake.layer, platform.layer),
        ),
      ),
    );
    return {
      out: console.out.join("\n"),
      err: console.err.join("\n"),
      exitCode: process.exitCode,
      seen: fake.seen,
      opened: platform.opened,
      slept: platform.slept,
      asked: platform.asked,
      menus: platform.menus,
    };
  } finally {
    process.exitCode = exitCodeBefore;
  }
}

/**
 * Points the real process environment, which commands read, at a temporary
 * home with no `RF_*` variables, and restores it afterwards. Call `setup`
 * in `beforeEach` and `teardown` in `afterEach`.
 */
export function isolatedEnvironment() {
  // CLAUDECODE too: a test run inside Claude Code would otherwise act as the agent.
  const names = [
    "XDG_CONFIG_HOME",
    "RF_API_KEY",
    "RF_API_URL",
    "RF_AGENT",
    "CLAUDECODE",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let home: Awaited<ReturnType<typeof temporaryHome>> | null = null;
  let cwdBefore = process.cwd();
  return {
    get home() {
      return home!.home;
    },
    get credentialsFile() {
      return join(home!.home, ".config", "rf", "credentials.json");
    },
    /** The working directory as the process reports it, with symlinks resolved. */
    get cwd() {
      return process.cwd();
    },
    async setup() {
      home = await temporaryHome();
      for (const name of names) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
      process.env.XDG_CONFIG_HOME = join(home.home, ".config");
      // Commands read the working directory for rf.json; keep that in the
      // temporary home too, so a test never writes into the repository.
      cwdBefore = process.cwd();
      process.chdir(home.home);
    },
    async teardown() {
      process.chdir(cwdBefore);
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      await home?.cleanup();
    },
  };
}

/** A request body as JSON when it is JSON, else as the text it is, such as an upload. */
function parseOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
