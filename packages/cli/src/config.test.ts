import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_API_URL,
  findProjectConfig,
  readCredentials,
  resolveSettings,
  writeCredentials,
  type Credentials,
  type Environment,
} from "./config";
import { temporaryHome } from "./test/fakes";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer));

const login: Credentials = {
  profiles: {
    default: {
      apiUrl: "https://api.example.com",
      apiKey: "rf_" + "p".repeat(43),
      keyPrefix: "rf_pppppppp",
      userId: "user_1",
      email: "eddie@example.com",
      defaultCollectionId: "col_1",
    },
  },
  agents: {
    agent_1: { apiKey: "rf_" + "a".repeat(43), keyPrefix: "rf_aaaaaaaa" },
  },
};

const noFlags = { profile: "default", apiUrl: Option.none<string>() };

describe("credentials", () => {
  let home: Awaited<ReturnType<typeof temporaryHome>>;
  beforeEach(async () => {
    home = await temporaryHome();
  });
  afterEach(() => home.cleanup());

  test("read as empty when nothing was ever stored", async () => {
    expect(await run(readCredentials(home.environment))).toEqual({
      profiles: {},
      agents: {},
    });
  });

  test("round-trip through a file only the owner can read", async () => {
    await run(writeCredentials(home.environment, login));
    expect(await run(readCredentials(home.environment))).toEqual(login);
    const file = join(home.home, ".config", "rf", "credentials.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home.home, ".config", "rf"))).mode & 0o777).toBe(
      0o700,
    );
  });

  test("live under XDG_CONFIG_HOME when it is set", async () => {
    const environment: Environment = {
      ...home.environment,
      env: { XDG_CONFIG_HOME: join(home.home, "xdg") },
    };
    await run(writeCredentials(environment, login));
    expect(
      (await stat(join(home.home, "xdg", "rf", "credentials.json"))).isFile(),
    ).toBe(true);
  });

  test("refuse a file that is not JSON, rather than silently logging out", async () => {
    await mkdir(join(home.home, ".config", "rf"), { recursive: true });
    await writeFile(
      join(home.home, ".config", "rf", "credentials.json"),
      "{nope",
    );
    await expect(run(readCredentials(home.environment))).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("the project file", () => {
  let home: Awaited<ReturnType<typeof temporaryHome>>;
  beforeEach(async () => {
    home = await temporaryHome();
  });
  afterEach(() => home.cleanup());

  test("is found in an ancestor of the working directory", async () => {
    await writeFile(
      join(home.home, "rf.json"),
      JSON.stringify({ collectionId: "col_1" }),
    );
    const deep = join(home.home, "a", "b");
    await mkdir(deep, { recursive: true });
    const found = await run(
      findProjectConfig({ ...home.environment, cwd: deep }),
    );
    expect(Option.getOrNull(found)).toEqual({
      path: join(home.home, "rf.json"),
      config: { collectionId: "col_1" },
    });
  });

  test("is none when no ancestor has one", async () => {
    expect(Option.isNone(await run(findProjectConfig(home.environment)))).toBe(
      true,
    );
  });
});

describe("resolving what a command runs with", () => {
  let home: Awaited<ReturnType<typeof temporaryHome>>;
  beforeEach(async () => {
    home = await temporaryHome();
  });
  afterEach(() => home.cleanup());

  test("has no key and the production api when nothing is set", async () => {
    expect(await run(resolveSettings(home.environment, noFlags))).toEqual({
      apiUrl: DEFAULT_API_URL,
      apiKey: null,
      keySource: "none",
      agentCaller: null,
      profile: "default",
      project: null,
      projectFile: null,
      defaultCollectionId: null,
    });
  });

  test("uses the stored login, including the address it was made against", async () => {
    await run(writeCredentials(home.environment, login));
    expect(await run(resolveSettings(home.environment, noFlags))).toMatchObject(
      {
        apiUrl: "https://api.example.com",
        apiKey: login.profiles.default!.apiKey,
        keySource: "profile",
      },
    );
  });

  describe("in a project that names an agent", () => {
    const withEnv = (env: Record<string, string>): Environment => ({
      ...home.environment,
      env: { ...home.environment.env, ...env },
    });
    beforeEach(async () => {
      await run(writeCredentials(home.environment, login));
      await writeFile(
        join(home.home, "rf.json"),
        JSON.stringify({ agentId: "agent_1" }),
      );
    });

    test("keeps a person on their own login", async () => {
      expect(
        await run(resolveSettings(home.environment, noFlags)),
      ).toMatchObject({
        apiKey: login.profiles.default!.apiKey,
        keySource: "profile",
        agentCaller: null,
        project: { agentId: "agent_1" },
        projectFile: join(home.home, "rf.json"),
      });
    });

    test("acts as the agent when Claude Code runs rf, or RF_AGENT says an agent does", async () => {
      for (const [env, agentCaller] of [
        [{ CLAUDECODE: "1" }, "Claude Code"],
        [{ RF_AGENT: "1" }, "RF_AGENT"],
        [{ RF_AGENT: "true", CLAUDECODE: "1" }, "RF_AGENT"],
      ] as const) {
        expect(await run(resolveSettings(withEnv(env), noFlags))).toMatchObject(
          {
            apiKey: login.agents.agent_1!.apiKey,
            keySource: "agent",
            agentCaller,
          },
        );
      }
    });

    test("acts as the agent for a hook, whatever the environment says", async () => {
      expect(
        await run(
          resolveSettings(home.environment, { ...noFlags, asAgent: true }),
        ),
      ).toMatchObject({ keySource: "agent", agentCaller: "hook" });
    });

    test("does not count RF_AGENT=0 as an agent", async () => {
      expect(
        await run(resolveSettings(withEnv({ RF_AGENT: "0" }), noFlags)),
      ).toMatchObject({ keySource: "profile", agentCaller: null });
    });
  });

  test("lets the environment beat both the agent and the login", async () => {
    await run(writeCredentials(home.environment, login));
    await writeFile(
      join(home.home, "rf.json"),
      JSON.stringify({ agentId: "agent_1" }),
    );
    const withEnv: Environment = {
      ...home.environment,
      env: {
        ...home.environment.env,
        CLAUDECODE: "1",
        RF_API_KEY: "rf_env",
        RF_API_URL: "https://env.example.com/",
      },
    };
    expect(await run(resolveSettings(withEnv, noFlags))).toMatchObject({
      apiKey: "rf_env",
      keySource: "env",
      apiUrl: "https://env.example.com",
    });
    expect(
      await run(
        resolveSettings(withEnv, {
          ...noFlags,
          apiUrl: Option.some("http://localhost:3002"),
        }),
      ),
    ).toMatchObject({ apiUrl: "http://localhost:3002" });
  });

  test("ignores a project agent it holds no key for, even for an agent", async () => {
    await run(writeCredentials(home.environment, login));
    await writeFile(
      join(home.home, "rf.json"),
      JSON.stringify({ agentId: "agent_unknown" }),
    );
    expect(
      await run(
        resolveSettings(
          {
            ...home.environment,
            env: { ...home.environment.env, CLAUDECODE: "1" },
          },
          noFlags,
        ),
      ),
    ).toMatchObject({ keySource: "profile", agentCaller: "Claude Code" });
  });
});
