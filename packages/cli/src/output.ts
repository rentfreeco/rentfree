import { Console } from "effect";

/**
 * How commands print. Text is the default and is written for a model to
 * read: short, aligned, no decoration. `--json` prints the value as the api
 * returned it, for scripts.
 */
export const print = (value: unknown, text: () => string, json: boolean) =>
  Console.log(json ? JSON.stringify(value, null, 2) : text());

/** Rows of label and value, with the values aligned. */
export function kv(rows: ReadonlyArray<readonly [string, unknown]>): string {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `${label.padEnd(width)}  ${show(value)}`)
    .join("\n");
}

/** A table with a header row, columns padded to their widest cell. */
export function table(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
): string {
  const cells = rows.map((row) => columns.map((column) => show(row[column])));
  const widths = columns.map((column, i) =>
    Math.max(column.length, ...cells.map((row) => row[i]!.length)),
  );
  const line = (row: ReadonlyArray<string>) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join("  ");
  return [line(columns), ...cells.map(line)].join("\n");
}

/** How much of a key is public: `rf_` and eight more, the prefix `rf whoami` shows. */
export const KEY_PREFIX_LENGTH = 11;

/**
 * A key as it is typed or pasted, with only its public prefix shown and
 * an asterisk for every character after it, so the person sees the right key
 * went in, and all of it, without the screen holding it. Text that does
 * not start like a key is all asterisks.
 */
export function maskKey(typed: string): string {
  const shown = "rf_".startsWith(typed.slice(0, 3))
    ? Math.min(typed.length, KEY_PREFIX_LENGTH)
    : 0;
  return typed.slice(0, shown) + "*".repeat(typed.length - shown);
}

/** Two-space indentation for a block under a heading. */
export const indent = (text: string) =>
  text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

function show(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(show).join(", ");
  return String(value);
}
