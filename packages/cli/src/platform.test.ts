import { describe, expect, test } from "vitest";
import { lineKey, menuKey, terminalOf } from "./platform";

const tty = { isTTY: true, columns: 120 };

describe("the terminal rf runs in", () => {
  test("is no terminal at all when stdout is a pipe", () => {
    expect(terminalOf({}, tty, { COLORTERM: "truecolor" })).toEqual({
      interactive: false,
      canAsk: false,
      columns: 80,
      color: "none",
    });
  });

  test("can be asked a question only when stdin is a terminal too", () => {
    expect(terminalOf(tty, tty, {})).toEqual({
      interactive: true,
      canAsk: true,
      columns: 120,
      color: "256",
    });
    expect(terminalOf(tty, {}, {})).toMatchObject({
      interactive: true,
      canAsk: false,
    });
  });

  test("takes every colour where COLORTERM says so, none under NO_COLOR", () => {
    expect(terminalOf(tty, tty, { COLORTERM: "24bit" }).color).toBe(
      "truecolor",
    );
    expect(terminalOf(tty, tty, { NO_COLOR: "1" })).toMatchObject({
      interactive: true,
      color: "none",
    });
  });

  test("is no terminal on a dumb one", () => {
    expect(terminalOf(tty, tty, { TERM: "dumb" })).toMatchObject({
      interactive: false,
      canAsk: false,
    });
  });
});

describe("a key in a menu", () => {
  test("moves the highlight with the arrows, j and k, and tab, wrapping at the ends", () => {
    expect(menuKey(0, 2, undefined, { name: "down" })).toEqual({ cursor: 1 });
    expect(menuKey(1, 2, undefined, { name: "down" })).toEqual({ cursor: 0 });
    expect(menuKey(0, 2, undefined, { name: "up" })).toEqual({ cursor: 1 });
    expect(menuKey(0, 3, "j", { name: "j" })).toEqual({ cursor: 1 });
    expect(menuKey(2, 3, "k", { name: "k" })).toEqual({ cursor: 1 });
    expect(menuKey(0, 2, "\t", { name: "tab" })).toEqual({ cursor: 1 });
  });

  test("chooses with enter, or a line's number", () => {
    expect(menuKey(1, 2, "\r", { name: "return" })).toEqual({ chosen: 1 });
    expect(menuKey(0, 2, "\n", { name: "enter" })).toEqual({ chosen: 0 });
    expect(menuKey(0, 2, "2", { name: "2" })).toEqual({ chosen: 1 });
    expect(menuKey(0, 2, "3", { name: "3" })).toBeNull();
  });

  test("leaves with ctrl-C or ctrl-D, and ignores anything else", () => {
    expect(menuKey(0, 2, "\x03", { name: "c", ctrl: true })).toEqual({
      chosen: null,
    });
    expect(menuKey(0, 2, "\x04", { name: "d", ctrl: true })).toEqual({
      chosen: null,
    });
    expect(menuKey(0, 2, "x", { name: "x" })).toBeNull();
    expect(menuKey(0, 2, "c", { name: "c" })).toBeNull();
  });
});

describe("a key on a line being typed", () => {
  test("adds what it types, a key at a time or pasted", () => {
    expect(lineKey("rf", "_", {})).toEqual({ typed: "rf_" });
    expect(lineKey("rf_", "a", { name: "a" })).toEqual({ typed: "rf_a" });
    expect(lineKey("rf_", "A", { name: "a" })).toEqual({ typed: "rf_A" });
  });

  test("takes back a character with backspace, or the line with ctrl-U", () => {
    expect(lineKey("rf_a", "\x7f", { name: "backspace" })).toEqual({
      typed: "rf_",
    });
    expect(lineKey("", "\x7f", { name: "backspace" })).toEqual({ typed: "" });
    expect(lineKey("rf_a", "\x15", { name: "u", ctrl: true })).toEqual({
      typed: "",
    });
  });

  test("answers with enter, and leaves with ctrl-C or ctrl-D", () => {
    expect(lineKey("rf_a", "\r", { name: "return" })).toEqual({
      done: "rf_a",
    });
    expect(lineKey("rf_a", "\x03", { name: "c", ctrl: true })).toEqual({
      done: null,
    });
    expect(lineKey("rf_a", "\x04", { name: "d", ctrl: true })).toEqual({
      done: null,
    });
  });

  test("ignores arrows, escapes, and other control keys", () => {
    expect(lineKey("rf_a", "\x1b[A", { name: "up" })).toBeNull();
    expect(lineKey("rf_a", "\t", { name: "tab" })).toBeNull();
    expect(lineKey("rf_a", "\x01", { name: "a", ctrl: true })).toBeNull();
    expect(lineKey("rf_a", "b", { name: "b", meta: true })).toBeNull();
  });
});
