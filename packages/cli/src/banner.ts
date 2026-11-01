import sdk from "@rentfree/sdk/package.json" with { type: "json" };
import type { Terminal } from "./platform";

/** "RENTFREE" in figlet's ANSI Shadow font. */
const ART = [
  "██████╗ ███████╗███╗   ██╗████████╗███████╗██████╗ ███████╗███████╗",
  "██╔══██╗██╔════╝████╗  ██║╚══██╔══╝██╔════╝██╔══██╗██╔════╝██╔════╝",
  "██████╔╝█████╗  ██╔██╗ ██║   ██║   █████╗  ██████╔╝█████╗  █████╗",
  "██╔══██╗██╔══╝  ██║╚██╗██║   ██║   ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝",
  "██║  ██║███████╗██║ ╚████║   ██║   ██║     ██║  ██║███████╗███████╗",
  "╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝",
];

const ART_WIDTH = Math.max(...ART.map((line) => [...line].length));

export const SLOGAN = "Living rent free in your AI agents";

/** The SDK the CLI is built on, which is released at the CLI's version. */
const LABEL = `TypeScript SDK · v${sdk.version}`;

/** Spaces between the frame and what it holds. */
const PAD = 3;
const INNER = ART_WIDTH + 2 * PAD;

/** The frame's width, its sides included: the narrowest terminal that gets it. */
export const FRAME_WIDTH = INNER + 2;

/**
 * The web app's accents: #60a5fa for the letters and the slogan, #2563eb
 * for the shadow and the frame, or the nearest of the 256 colours where
 * that is all there is.
 */
const PALETTE = {
  truecolor: { face: "\x1b[38;2;96;165;250m", shadow: "\x1b[38;2;37;99;235m" },
  "256": { face: "\x1b[38;5;75m", shadow: "\x1b[38;5;26m" },
} as const;

const FG = "\x1b[39m";

/** The colours `rf init` writes with, each the identity where there are none. */
export function styleFor(terminal: Terminal) {
  const palette = terminal.color === "none" ? null : PALETTE[terminal.color];
  const wrap = (open: string | undefined, close: string) => (text: string) =>
    open ? `${open}${text}${close}` : text;
  const green = wrap(palette ? "\x1b[32m" : undefined, FG);
  const face = wrap(palette?.face, FG);
  return {
    face,
    shadow: wrap(palette?.shadow, FG),
    dim: wrap(palette ? "\x1b[2m" : undefined, "\x1b[22m"),
    /** A line that went well. */
    done: (line: string) => `${green("✓")} ${line}`,
    /** A step starting. */
    step: (line: string) => `${face("◆")} ${line}`,
  };
}

/**
 * What `rf init` opens with: the name, the slogan, and the SDK's version
 * in a frame, or one line of the same on a terminal too narrow for it.
 * Null off a terminal, where nobody would see it as a banner.
 */
export function banner(terminal: Terminal): string | null {
  if (!terminal.interactive) return null;
  const s = styleFor(terminal);
  if (terminal.columns < FRAME_WIDTH) {
    return `${s.face("rentfree")}  ${SLOGAN}  ${s.dim(`v${sdk.version}`)}`;
  }
  const letters = (line: string) =>
    line
      .padEnd(ART_WIDTH)
      .replace(/(█+)|([^█ ]+)/g, (run, solid?: string) =>
        solid ? s.face(run) : s.shadow(run),
      );
  const side = s.shadow("╎");
  const row = (content: string, width: number) =>
    `${side}${" ".repeat(PAD)}${content}${" ".repeat(INNER - PAD - width)}${side}`;
  const blank = row("", 0);
  const rule = INNER - [...LABEL].length - 4;
  return [
    s.shadow(`╭${"─".repeat(INNER)}╮`),
    blank,
    ...ART.map((line) => row(letters(line), ART_WIDTH)),
    blank,
    row(s.face(SLOGAN), SLOGAN.length),
    blank,
    `${s.shadow(`╰${"─".repeat(rule)}`)} ${s.dim(LABEL)} ${s.shadow("──╯")}`,
  ].join("\n");
}
