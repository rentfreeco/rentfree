import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { homedir } from "node:os";

/** The production api. `--api-url` and `RF_API_URL` override it. */
export const DEFAULT_API_URL = "https://api.rentfree.dev";

/** One stored login: a user-level key and where it came from. */
export interface Profile {
  apiUrl: string;
  apiKey: string;
  keyPrefix: string;
  userId: string;
  email: string | null;
  /** The account's default collection at login, so commands need not ask. */
  defaultCollectionId: string | null;
}

/** A key minted for an agent, kept beside the login so a project can act as it. */
export interface AgentKey {
  apiKey: string;
  keyPrefix: string;
}

/** What `credentials.json` holds. Never printed, never committed. */
export interface Credentials {
  profiles: Record<string, Profile>;
  agents: Record<string, AgentKey>;
}

/** What `rf.json` in a project holds. Committed; it names things, never secrets. */
export interface ProjectConfig {
  collectionId?: string;
  agentId?: string;
}

/** A fresh empty store each time: callers add to what they read, so a shared constant would remember. */
export const emptyCredentials = (): Credentials => ({
  profiles: {},
  agents: {},
});

/** The process's view of the world, injectable so tests never touch the real one. */
export interface Environment {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
}

export const realEnvironment = (): Environment => ({
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
});

/**
 * Where credentials live: `$XDG_CONFIG_HOME/rf`, by default `~/.config/rf`.
 * Effect has no helper for this, so it is spelled out here.
 */
export const configDir = (environment: Environment) =>
  Effect.map(Path, (path) =>
    path.join(
      environment.env.XDG_CONFIG_HOME || path.join(environment.home, ".config"),
      "rf",
    ),
  );

export const credentialsPath = (environment: Environment) =>
  Effect.flatMap(configDir(environment), (dir) =>
    Effect.map(Path, (path) => path.join(dir, "credentials.json")),
  );

/** The stored credentials, or none when the file does not exist. */
export const readCredentials = (environment: Environment) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const file = yield* credentialsPath(environment);
    if (!(yield* fs.exists(file))) return emptyCredentials();
    const text = yield* fs.readFileString(file);
    return parseCredentials(text);
  });

/**
 * Writes the credentials with owner-only permissions: the directory 0700 and
 * the file 0600, set again after writing in case the file already existed
 * with looser ones.
 */
export const writeCredentials = (
  environment: Environment,
  credentials: Credentials,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const dir = yield* configDir(environment);
    const file = yield* credentialsPath(environment);
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(
      file,
      JSON.stringify(credentials, null, 2) + "\n",
      {
        mode: 0o600,
      },
    );
    yield* fs.chmod(file, 0o600);
  });

/** `rf.json` in the working directory or the nearest ancestor that has one. */
export const findProjectConfig = (environment: Environment) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    let dir = environment.cwd;
    for (;;) {
      const file = path.join(dir, "rf.json");
      if (yield* fs.exists(file)) {
        const text = yield* fs.readFileString(file);
        return Option.some({ path: file, config: parseProject(text) });
      }
      const parent = path.dirname(dir);
      if (parent === dir) return Option.none();
      dir = parent;
    }
  });

/**
 * Writes fields into the project's `rf.json`: the one an ancestor already
 * has, else a new one in the working directory. Returns where it wrote.
 */
export const writeProjectConfig = (
  environment: Environment,
  patch: Partial<ProjectConfig>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const found = yield* findProjectConfig(environment);
    const file = Option.match(found, {
      onNone: () => path.join(environment.cwd, "rf.json"),
      onSome: (f) => f.path,
    });
    const config = {
      ...Option.match(found, { onNone: () => ({}), onSome: (f) => f.config }),
      ...patch,
    };
    yield* fs.writeFileString(file, JSON.stringify(config, null, 2) + "\n");
    return { path: file, config };
  });

/** Where the key a command will use came from. */
export type KeySource = "env" | "agent" | "profile" | "none";

/** How rf knows an agent, not a person, is running it. */
export type AgentCaller = "hook" | "RF_AGENT" | "Claude Code";

/**
 * Whether an agent is running rf, and how that is known: `RF_AGENT=1`,
 * which anything may set, or `CLAUDECODE`, which Claude Code sets for every
 * command it starts. Null is a person at a terminal of their own. A hook is
 * an agent too, but says so itself, through `resolveSettings`.
 */
export function agentCallerOf(
  env: Record<string, string | undefined>,
): AgentCaller | null {
  if (/^(1|true|yes)$/i.test(env.RF_AGENT ?? "")) return "RF_AGENT";
  if (env.CLAUDECODE) return "Claude Code";
  return null;
}

/** Why rf counted its caller as an agent, as the end of a sentence. */
export const agentCallerReason: Record<AgentCaller, string> = {
  hook: "a Claude Code hook ran it",
  RF_AGENT: "RF_AGENT is set",
  "Claude Code": "Claude Code ran it",
};

/** Where the key came from, for `rf whoami` and `rf config show`: `env`, `profile`, or the agent and why. */
export const keyOrigin = (settings: Settings) =>
  settings.keySource === "agent" && settings.agentCaller
    ? `agent, as ${agentCallerReason[settings.agentCaller]}`
    : settings.keySource;

export interface Settings {
  apiUrl: string;
  apiKey: string | null;
  keySource: KeySource;
  /** How rf knows an agent is running it, or null for a person. */
  agentCaller: AgentCaller | null;
  profile: string;
  project: ProjectConfig | null;
  /** The rf.json `project` came from. */
  projectFile: string | null;
  /** The account's default collection, as the login recorded it. */
  defaultCollectionId: string | null;
}

/**
 * What a command runs with. The key is `RF_API_KEY` if set; else, when an
 * agent is running rf, the key of the agent the project names; else the
 * profile's login. So a person in a project that names an agent keeps
 * their own login there, account commands included, while Claude Code,
 * its hooks, and anything with `RF_AGENT=1` act as the agent and stay
 * within what it may do. The address is the flag, else `RF_API_URL`, else
 * what the profile stored at login, else the production api.
 */
export const resolveSettings = (
  environment: Environment,
  options: {
    profile: string;
    apiUrl: Option.Option<string>;
    /** The caller is an agent whatever the environment says: a hook. */
    asAgent?: boolean;
  },
) =>
  Effect.gen(function* () {
    const credentials = yield* readCredentials(environment);
    const found = Option.getOrNull(yield* findProjectConfig(environment));
    const project = found?.config ?? null;
    const profile = credentials.profiles[options.profile];
    const agentCaller = options.asAgent
      ? "hook"
      : agentCallerOf(environment.env);

    let apiKey: string | null = null;
    let keySource: KeySource = "none";
    const fromEnv = environment.env.RF_API_KEY;
    const agentKey =
      agentCaller && project?.agentId
        ? credentials.agents[project.agentId]
        : undefined;
    if (fromEnv) {
      apiKey = fromEnv;
      keySource = "env";
    } else if (agentKey) {
      apiKey = agentKey.apiKey;
      keySource = "agent";
    } else if (profile) {
      apiKey = profile.apiKey;
      keySource = "profile";
    }

    const apiUrl = stripSlash(
      Option.getOrUndefined(options.apiUrl) ||
        environment.env.RF_API_URL ||
        profile?.apiUrl ||
        DEFAULT_API_URL,
    );
    return {
      apiUrl,
      apiKey,
      keySource,
      agentCaller,
      profile: options.profile,
      project,
      projectFile: found?.path ?? null,
      defaultCollectionId: profile?.defaultCollectionId ?? null,
    } satisfies Settings;
  });

const stripSlash = (url: string) => url.replace(/\/+$/, "");

function parseCredentials(text: string): Credentials {
  const value = parseObject(text, "credentials.json");
  const profiles = isObject(value.profiles) ? value.profiles : {};
  const agents = isObject(value.agents) ? value.agents : {};
  return {
    profiles: Object.fromEntries(
      Object.entries(profiles).flatMap(([name, p]) =>
        isObject(p) &&
        typeof p.apiUrl === "string" &&
        typeof p.apiKey === "string" &&
        typeof p.keyPrefix === "string" &&
        typeof p.userId === "string"
          ? [
              [
                name,
                {
                  apiUrl: p.apiUrl,
                  apiKey: p.apiKey,
                  keyPrefix: p.keyPrefix,
                  userId: p.userId,
                  email: typeof p.email === "string" ? p.email : null,
                  defaultCollectionId:
                    typeof p.defaultCollectionId === "string"
                      ? p.defaultCollectionId
                      : null,
                } satisfies Profile,
              ],
            ]
          : [],
      ),
    ),
    agents: Object.fromEntries(
      Object.entries(agents).flatMap(([id, a]) =>
        isObject(a) &&
        typeof a.apiKey === "string" &&
        typeof a.keyPrefix === "string"
          ? [
              [
                id,
                { apiKey: a.apiKey, keyPrefix: a.keyPrefix } satisfies AgentKey,
              ],
            ]
          : [],
      ),
    ),
  };
}

function parseProject(text: string): ProjectConfig {
  const value = parseObject(text, "rf.json");
  return {
    ...(typeof value.collectionId === "string"
      ? { collectionId: value.collectionId }
      : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
  };
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (!isObject(value)) throw new Error(`${what} must hold a JSON object`);
  return value;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
