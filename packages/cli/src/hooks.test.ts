import { describe, expect, test } from "vitest";
import {
  rentfreeHooks,
  withRentfree,
  withoutRentfree,
  type ClaudeSettings,
} from "./hooks";

const theirs: ClaudeSettings = {
  model: "opus",
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [{ type: "command", command: "./setup.sh" }],
      },
    ],
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] },
    ],
  },
};

describe("Claude Code hook settings", () => {
  test("adds capture and memory, and keeps everything else", () => {
    const next = withRentfree(theirs, { tools: false, recall: false });
    expect(next.model).toBe("opus");
    expect(next.hooks!.PreToolUse).toEqual(theirs.hooks!.PreToolUse);
    expect(next.hooks!.SessionStart).toEqual([
      theirs.hooks!.SessionStart![0],
      // No matcher: every kind of start, forked sessions included.
      { hooks: [{ type: "command", command: "rf hooks run session-start" }] },
    ]);
    expect(rentfreeHooks(next)).toEqual([
      { event: "SessionStart", command: "rf hooks run session-start" },
      { event: "UserPromptSubmit", command: "rf hooks run prompt" },
      { event: "Stop", command: "rf hooks run stop" },
      { event: "SessionEnd", command: "rf hooks run session-end" },
    ]);
    // Claude Code's default SessionEnd budget is 1.5 s for every hook together.
    expect(next.hooks!.SessionEnd![0]!.hooks[0]!.timeout).toBe(10);
  });

  test("adds tool logging and per-prompt recall only when asked", () => {
    const next = withRentfree({}, { tools: true, recall: true, budget: 800 });
    expect(rentfreeHooks(next)).toEqual([
      {
        event: "SessionStart",
        command: "rf hooks run session-start --budget 800",
      },
      {
        event: "UserPromptSubmit",
        command: "rf hooks run prompt --recall --budget 800",
      },
      { event: "Stop", command: "rf hooks run stop" },
      { event: "SessionEnd", command: "rf hooks run session-end" },
      { event: "PostToolUse", command: "rf hooks run tool" },
    ]);
  });

  test("installing again replaces rentfree's hooks rather than adding more", () => {
    const once = withRentfree(theirs, { tools: true, recall: false });
    const twice = withRentfree(once, { tools: false, recall: false });
    expect(rentfreeHooks(twice)).toHaveLength(4);
    expect(twice.hooks!.PostToolUse).toBeUndefined();
    expect(twice.hooks!.SessionStart).toHaveLength(2);
  });

  test("removing takes only rentfree's hooks, and drops what they leave empty", () => {
    const installed = withRentfree(theirs, { tools: true, recall: true });
    expect(withoutRentfree(installed)).toEqual(theirs);
    expect(
      withoutRentfree(withRentfree({}, { tools: false, recall: false })),
    ).toEqual({});
  });

  test("leaves a hook of someone else's in a shared group", () => {
    const shared: ClaudeSettings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "rf hooks run stop" },
              { type: "command", command: "./notify.sh" },
            ],
          },
        ],
      },
    };
    expect(withoutRentfree(shared)).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
      },
    });
  });
});
