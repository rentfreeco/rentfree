import { Context, Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { emitKeypressEvents } from "node:readline";

/**
 * What stdout and stdin are attached to. Decoration, such as `rf init`'s
 * banner, is for a person at a terminal, and so is a question; a pipe,
 * which is how a model or a script reads `rf`, gets plain text and is
 * never asked anything.
 */
export interface Terminal {
  /** stdout is a terminal, so a person is reading. */
  readonly interactive: boolean;
  /** stdin is a terminal too, so that person can answer a question. */
  readonly canAsk: boolean;
  readonly columns: number;
  /** How much colour to use: none off a terminal or under `NO_COLOR`. */
  readonly color: "none" | "256" | "truecolor";
}

type Stream = { readonly isTTY?: boolean; readonly columns?: number };

/** Reads a terminal off stdout, stdin, and the environment, for `Platform.live`. */
export function terminalOf(
  stdout: Stream,
  stdin: Stream,
  env: Record<string, string | undefined>,
): Terminal {
  const interactive = stdout.isTTY === true && env.TERM !== "dumb";
  const color =
    !interactive || env.NO_COLOR
      ? "none"
      : /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")
        ? "truecolor"
        : "256";
  return {
    interactive,
    canAsk: interactive && stdin.isTTY === true,
    columns: stdout.columns ?? 80,
    color,
  };
}

/** A key as readline's keypress events describe it. */
export interface Key {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

const leaves = (key: Key) => key.ctrl && (key.name === "c" || key.name === "d");
const enters = (key: Key) => key.name === "return" || key.name === "enter";

/**
 * What a key does to a menu of `count` lines with `cursor` highlighted:
 * moves the highlight, wrapping at the ends; chooses, with enter or a
 * line's number; or leaves, with ctrl-C or ctrl-D, as null. Any other key
 * does nothing.
 */
export function menuKey(
  cursor: number,
  count: number,
  text: string | undefined,
  key: Key,
): { readonly cursor: number } | { readonly chosen: number | null } | null {
  if (leaves(key)) return { chosen: null };
  if (enters(key)) return { chosen: cursor };
  if (key.name === "up" || key.name === "k") {
    return { cursor: (cursor + count - 1) % count };
  }
  if (key.name === "down" || key.name === "j" || key.name === "tab") {
    return { cursor: (cursor + 1) % count };
  }
  const n = Number(text);
  if (text && /^[1-9]$/.test(text) && n <= count) return { chosen: n - 1 };
  return null;
}

/**
 * What a key does to a line being typed or pasted: adds what it types;
 * takes back the last character with backspace, or the whole line with
 * ctrl-U; answers with enter; or leaves, with ctrl-C or ctrl-D, as null.
 * Any other key, such as an arrow, does nothing.
 */
export function lineKey(
  typed: string,
  text: string | undefined,
  key: Key,
): { readonly typed: string } | { readonly done: string | null } | null {
  if (leaves(key)) return { done: null };
  if (enters(key)) return { done: typed };
  if (key.name === "backspace") {
    return { typed: [...typed].slice(0, -1).join("") };
  }
  if (key.ctrl && key.name === "u") return { typed: "" };
  if (text && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text)) {
    return { typed: typed + text };
  }
  return null;
}

/** A menu a command draws and the platform runs. */
export interface Menu {
  readonly count: number;
  /** The menu with line `cursor` highlighted, or, once chosen, what stays on screen. */
  readonly render: (cursor: number, chosen: boolean) => string;
}

/**
 * Hands each key on stdin to `onKey` in raw mode, so nothing is echoed
 * but what the command draws. The function it returns puts stdin back.
 */
function listen(onKey: (text: string | undefined, key: Key) => void) {
  const input = process.stdin;
  const handler = (text: string | undefined, key: Key | undefined) =>
    onKey(text, key ?? {});
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  input.on("keypress", handler);
  return () => {
    input.off("keypress", handler);
    input.setRawMode?.(false);
    input.pause();
  };
}

/**
 * What a command needs from the machine it runs on, behind a seam so tests
 * can wait no time, open no browser, read a chosen stdin, choose the
 * terminal, and answer its questions.
 */
export class Platform extends Context.Service<
  Platform,
  {
    /** This machine's name, for naming a login after it. */
    readonly hostname: string;
    /** Tries the platform's opener; true if one was launched. Never fails. */
    readonly openBrowser: (url: string) => Effect.Effect<boolean>;
    readonly sleep: (ms: number) => Effect.Effect<void>;
    /** Everything on stdin, for what a command is piped: a hook's JSON, events, a document. */
    readonly readStdin: Effect.Effect<string>;
    readonly terminal: Terminal;
    /**
     * Asks a question on the terminal and reads one line back, typed or
     * pasted. What has been typed so far is drawn after the question
     * through `show`, such as a key with most of it masked. Null when the
     * person leaves with ctrl-C or ctrl-D. Only for `terminal.canAsk`.
     */
    readonly ask: (
      question: string,
      options?: { readonly show?: (typed: string) => string },
    ) => Effect.Effect<string | null>;
    /**
     * Runs a menu: arrow keys move, enter chooses, and the menu is drawn
     * again in place at each move. The index chosen, or null when the
     * person leaves. Only for `terminal.canAsk`.
     */
    readonly choose: (menu: Menu) => Effect.Effect<number | null>;
  }
>()("rf/Platform") {
  static readonly live = Layer.succeed(Platform, {
    hostname: hostname(),
    openBrowser: (url) =>
      Effect.sync(() => {
        const [command, args] =
          process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
        try {
          const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
          });
          child.on("error", () => {});
          child.unref();
          return true;
        } catch {
          return false;
        }
      }),
    sleep: (ms) => Effect.sleep(ms),
    readStdin: Effect.promise(async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    }),
    terminal: terminalOf(process.stdout, process.stdin, process.env),
    ask: (question, { show = (typed: string) => typed } = {}) =>
      Effect.callback<string | null>((resume) => {
        const output = process.stdout;
        let typed = "";
        // The start of the line, cleared, and the question and answer anew.
        const paint = () => output.write(`\r\x1b[K${question}${show(typed)}`);
        let finished = false;
        const finish = (answer: string | null) => {
          if (finished) return;
          finished = true;
          stop();
          output.write("\n");
          resume(Effect.succeed(answer));
        };
        const stop = listen((text, key) => {
          const next = lineKey(typed, text, key);
          if (next === null) return;
          if ("done" in next) {
            finish(next.done);
            return;
          }
          typed = next.typed;
          paint();
        });
        paint();
        return Effect.sync(() => finish(null));
      }),
    choose: ({ count, render }) =>
      Effect.callback<number | null>((resume) => {
        const output = process.stdout;
        let cursor = 0;
        let shown = "";
        // Back to the menu's first line, clear below, and draw it anew.
        const paint = (text: string) => {
          const up = shown ? shown.split("\n").length - 1 : 0;
          output.write(`\r${up ? `\x1b[${up}A` : ""}\x1b[J${text}`);
          shown = text;
        };
        let finished = false;
        const finish = (chosen: number | null) => {
          if (finished) return;
          finished = true;
          stop();
          if (chosen !== null) paint(render(chosen, true));
          output.write("\x1b[?25h\n");
          resume(Effect.succeed(chosen));
        };
        output.write("\x1b[?25l");
        const stop = listen((text, key) => {
          const next = menuKey(cursor, count, text, key);
          if (next === null) return;
          if ("chosen" in next) {
            finish(next.chosen);
            return;
          }
          cursor = next.cursor;
          paint(render(cursor, false));
        });
        paint(render(cursor, false));
        return Effect.sync(() => finish(null));
      }),
  });
}
