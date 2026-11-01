import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isolatedEnvironment, runRf as rf } from "./test/fakes";

const me = {
  user: {
    id: "user_1",
    email: "eddie@example.com",
    embedModel: "openai/text-embedding-3-small",
    embedDimensions: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  caller: {
    agentId: null,
    apiKeyId: "key_1",
    keyPrefix: "rf_7Hq2x9Lm",
    keyName: "CLI on test",
  },
  collections: [
    {
      id: "col_1",
      name: "default",
      isDefault: true,
      createdAt: "",
      archivedAt: null,
    },
    {
      id: "col_2",
      name: "work",
      isDefault: false,
      createdAt: "",
      archivedAt: null,
    },
  ],
  agents: [{ id: "agent_1", name: "claude-code" }],
};

describe("rf whoami", () => {
  const env = isolatedEnvironment();
  beforeEach(() => env.setup());
  afterEach(() => env.teardown());

  test("prints who the key belongs to, as text", async () => {
    process.env.RF_API_KEY = "rf_" + "k".repeat(43);
    process.env.RF_API_URL = "https://api.example.com";
    const { out, err, exitCode, seen } = await rf(
      ["whoami"],
      [{ path: "/api/v1/me", body: me }],
    );
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(seen[0]).toMatchObject({ url: "https://api.example.com/api/v1/me" });
    expect(out).toBe(
      [
        "user   user_1  eddie@example.com",
        "key    CLI on test  rf_7Hq2x9Lm  user-level (env)",
        "api    https://api.example.com",
        "model  openai/text-embedding-3-small",
        "collections",
        "  id     name     default",
        "  col_1  default  default",
        "  col_2  work     ",
        "agents",
        "  id       name",
        "  agent_1  claude-code",
      ].join("\n"),
    );
  });

  test("prints the api's answer as JSON with --json", async () => {
    process.env.RF_API_KEY = "rf_" + "k".repeat(43);
    const { out } = await rf(
      ["--json", "whoami"],
      [{ path: "/api/v1/me", body: me }],
    );
    expect(JSON.parse(out)).toEqual(me);
  });

  test("says how to log in when there is no key, and exits 1", async () => {
    const { out, err, exitCode, seen } = await rf(["whoami"], []);
    expect(out).toBe("");
    expect(err).toBe("Not logged in. Run `rf init`, or set RF_API_KEY.");
    expect(exitCode).toBe(1);
    expect(seen).toEqual([]);
  });

  test("relays the api's refusal in one line", async () => {
    process.env.RF_API_KEY = "rf_" + "k".repeat(43);
    const { err, exitCode } = await rf(
      ["whoami"],
      [{ path: "/api/v1/me", status: 401, body: { error: "unauthorized" } }],
    );
    expect(err).toBe("Not logged in. Run `rf init`, or set RF_API_KEY.");
    expect(exitCode).toBe(1);
  });

  test("takes --api-url over everything else", async () => {
    process.env.RF_API_KEY = "rf_" + "k".repeat(43);
    process.env.RF_API_URL = "https://env.example.com";
    const { seen } = await rf(
      ["--api-url", "http://localhost:3002", "whoami"],
      [{ path: "/api/v1/me", body: me }],
    );
    expect(seen[0]!.url).toBe("http://localhost:3002/api/v1/me");
  });
});

describe("rf", () => {
  test("refuses a command it does not have, as a parse error", async () => {
    await expect(rf(["nope"], [])).rejects.toThrow();
  });
});
