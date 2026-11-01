/**
 * Claude Code's hook settings, read and changed without touching anything
 * else in the file. Pure functions, so the merge rules are tested without a
 * file system. Every hook rentfree adds runs a command starting with
 * `rf hooks run`, which is how uninstall and status find them again.
 */

export const HOOK_MARK = "rf hooks run";

/** The events rentfree hooks, and what each `rf hooks run` is called. */
export const HOOK_EVENTS = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt",
  Stop: "stop",
  SessionEnd: "session-end",
  PostToolUse: "tool",
} as const;

export type HookEvent = keyof typeof HOOK_EVENTS;
export type HookName = (typeof HOOK_EVENTS)[HookEvent];

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

/** A Claude Code settings file: hooks, and whatever else it holds. */
export type ClaudeSettings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
};

export interface InstallOptions {
  /** Log every tool call and its result too. */
  tools: boolean;
  /** Fetch a context pack for every prompt, not only at the start. */
  recall: boolean;
  /** The token budget for the packs, when not the api's default. */
  budget?: number;
}

const ours = (hook: HookCommand) =>
  typeof hook.command === "string" && hook.command.startsWith(HOOK_MARK);

/** The settings without any hook rentfree added; everything else is kept. */
export function withoutRentfree(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => !ours(hook)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/** The settings with rentfree's hooks, replacing any it added before. */
export function withRentfree(
  settings: ClaudeSettings,
  options: InstallOptions,
): ClaudeSettings {
  const base = withoutRentfree(settings);
  const budget = options.budget ? ` --budget ${options.budget}` : "";
  const add: Array<[HookEvent, HookGroup]> = [
    [
      "SessionStart",
      {
        // Every kind of start, with no matcher: a new, resumed, cleared,
        // compacted, or forked session each begins without the pack, and so
        // will any kind Claude Code adds.
        hooks: [command(`session-start${budget}`)],
      },
    ],
    [
      "UserPromptSubmit",
      {
        hooks: [command(`prompt${options.recall ? ` --recall${budget}` : ""}`)],
      },
    ],
    ["Stop", { hooks: [command("stop")] }],
    // Claude Code gives every SessionEnd hook 1.5 seconds between them
    // unless a hook asks for longer; ending a session is one request.
    ["SessionEnd", { hooks: [command("session-end", 10)] }],
  ];
  if (options.tools) {
    add.push(["PostToolUse", { matcher: "*", hooks: [command("tool")] }]);
  }
  const hooks = { ...(base.hooks ?? {}) };
  for (const [event, group] of add) {
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  return { ...base, hooks };
}

/** Which rentfree hooks the settings hold, by event, with their commands. */
export function rentfreeHooks(
  settings: ClaudeSettings,
): Array<{ event: string; command: string }> {
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      (group.hooks ?? [])
        .filter(ours)
        .map((hook) => ({ event, command: hook.command! })),
    ),
  );
}

function command(args: string, timeout?: number): HookCommand {
  return {
    type: "command",
    command: `${HOOK_MARK} ${args}`,
    ...(timeout ? { timeout } : {}),
  };
}
