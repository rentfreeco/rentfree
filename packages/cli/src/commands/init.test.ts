import sdk from "@rentfree/sdk/package.json" with { type: "json" };
import { readFile, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Terminal } from "../platform";
import { isolatedEnvironment, runRf, type Canned } from "../test/fakes";

const KEY = "rf_" + "k".repeat(43);

const started: Canned = {
  method: "POST",
  path: "/api/auth/device",
  status: 201,
  body: {
    deviceCode: "d".repeat(43),
    userCode: "HJKD-MPQR",
    verifyUrl: "https://app.example.com/cli?code=HJKD-MPQR",
    expiresIn: 600,
    interval: 5,
  },
};

const approved = {
  status: "approved",
  apiKey: KEY,
  keyPrefix: KEY.slice(0, 11),
  user: { id: "user_1", email: "eddie@example.com" },
  defaultCollectionId: "col_1",
};

const me = {
  user: {
    id: "user_1",
    email: "eddie@example.com",
    embedModel: "m",
    embedDimensions: null,
  },
  caller: {
    agentId: null,
    apiKeyId: "key_1",
    keyPrefix: KEY.slice(0, 11),
    keyName: "CLI",
  },
  collections: [{ id: "col_1", name: "default", isDefault: true }],
  agents: [],
};

const meAnswer: Canned = { path: "/api/v1/me", body: me };
const refusedKey: Canned = {
  path: "/api/v1/me",
  status: 401,
  body: { error: "unauthorized" },
};

/** Polls answer pending until the given call, then approved. */
const pollThen = (
  approveOn: number,
  before: Array<{ status: number; body: unknown }> = [],
): Canned => ({
  method: "POST",
  path: "/api/auth/device/poll",
  respond: (call) =>
    call < before.length
      ? before[call]!
      : call < approveOn
        ? { status: 200, body: { status: "pending" } }
        : { status: 200, body: approved },
});

/** A terminal for stdout only, as with a piped stdin. */
const wide: Terminal = {
  interactive: true,
  canAsk: false,
  columns: 100,
  color: "none",
};
/** A person at a terminal, who can answer. */
const person: Terminal = { ...wide, canAsk: true };

const routes = (seen: Array<{ method: string; url: string }>) =>
  seen.map((s) => `${s.method} ${new URL(s.url).pathname}`);

describe("rf init", () => {
  const env = isolatedEnvironment();
  beforeEach(() => env.setup());
  afterEach(() => env.teardown());

  const stored = async () =>
    JSON.parse(await readFile(env.credentialsFile, "utf8"));

  test("opens the browser, polls until approved, and stores the key", async () => {
    process.env.RF_API_URL = "https://api.example.com";
    const { out, err, exitCode, seen, opened, slept, asked } = await runRf(
      ["init"],
      [started, pollThen(2), meAnswer],
    );
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(asked).toEqual([]);
    expect(opened).toEqual(["https://app.example.com/cli?code=HJKD-MPQR"]);
    expect(slept).toEqual([5000, 5000, 5000]);
    expect(out).toBe(
      [
        "Opening https://app.example.com/cli?code=HJKD-MPQR in your browser.",
        "If it did not open, visit that address and enter HJKD-MPQR.",
        "Waiting for approval...",
        "✓ Logged in as eddie@example.com",
        `✓ API key ${KEY.slice(0, 11)}… saved in ${env.credentialsFile}`,
        "✓ Default collection: default (col_1)",
      ].join("\n"),
    );
    // The session was named after the machine, and no key was sent before there was one.
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.com/api/auth/device",
      body: { name: "CLI on test-host" },
    });
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[1]).toMatchObject({ body: { deviceCode: "d".repeat(43) } });
    // The collection's name was asked with the new key.
    expect(seen.at(-1)).toMatchObject({
      url: "https://api.example.com/api/v1/me",
      headers: { authorization: `Bearer ${KEY}` },
    });

    expect((await stored()).profiles.default).toEqual({
      apiUrl: "https://api.example.com",
      apiKey: KEY,
      keyPrefix: KEY.slice(0, 11),
      userId: "user_1",
      email: "eddie@example.com",
      defaultCollectionId: "col_1",
    });
    expect((await stat(env.credentialsFile)).mode & 0o777).toBe(0o600);

    // And the stored key is what the next command uses.
    const who = await runRf(["whoami"], [meAnswer]);
    expect(who.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(who.out).toContain("(profile)");
  });

  test("names the collection by its id when its name cannot be fetched", async () => {
    const { out, exitCode } = await runRf(
      ["init"],
      [started, pollThen(1), { ...meAnswer, status: 500, body: {} }],
    );
    expect(exitCode).toBeUndefined();
    expect(out).toContain("✓ Default collection: col_1");
    expect((await stored()).profiles.default.apiKey).toBe(KEY);
  });

  test("still answers to rf login", async () => {
    const { out, exitCode } = await runRf(
      ["login"],
      [started, pollThen(1), meAnswer],
    );
    expect(exitCode).toBeUndefined();
    expect(out).toContain("✓ Logged in as eddie@example.com");
  });

  test("backs off when told to slow down", async () => {
    const { slept, exitCode } = await runRf(
      ["init"],
      [started, pollThen(2, [{ status: 429, body: { error: "slow_down" } }])],
    );
    expect(exitCode).toBeUndefined();
    expect(slept).toEqual([5000, 10000, 10000]);
  });

  test("says when the login was denied, and stores nothing", async () => {
    const { err, exitCode } = await runRf(
      ["init"],
      [
        started,
        {
          method: "POST",
          path: "/api/auth/device/poll",
          status: 403,
          body: { error: "access_denied" },
        },
      ],
    );
    expect(err).toBe("The login was denied in the browser.");
    expect(exitCode).toBe(1);
    await expect(stat(env.credentialsFile)).rejects.toThrow();
  });

  test("says when the code expired", async () => {
    const { err, exitCode } = await runRf(
      ["init"],
      [
        started,
        {
          method: "POST",
          path: "/api/auth/device/poll",
          status: 410,
          body: { error: "device_session_expired" },
        },
      ],
    );
    expect(err).toBe(
      "The code expired before it was approved. Run `rf init` again.",
    );
    expect(exitCode).toBe(1);
  });

  test("gives up when the session's time runs out without an answer", async () => {
    const short: Canned = {
      ...started,
      body: { ...(started.body as object), expiresIn: 12, interval: 5 },
    };
    const { err, slept } = await runRf(["init"], [short, pollThen(100)]);
    expect(slept).toEqual([5000, 5000, 5000]);
    expect(err).toContain("expired");
  });

  test("prints progress to stderr and one object to stdout under --json", async () => {
    const { out, err, asked } = await runRf(
      ["--json", "init"],
      [started, pollThen(1), meAnswer],
      { terminal: person },
    );
    expect(asked).toEqual([]);
    expect(err).toContain("Waiting for approval...");
    expect(JSON.parse(out)).toMatchObject({
      userId: "user_1",
      keyPrefix: KEY.slice(0, 11),
      defaultCollectionId: "col_1",
    });
  });

  test("has no --with-key; a machine without a browser sets RF_API_KEY", async () => {
    await expect(
      runRf(["init", "--with-key"], [], { stdin: KEY }),
    ).rejects.toThrow();
    await expect(stat(env.credentialsFile)).rejects.toThrow();
  });

  describe("asked how to authenticate", () => {
    const menu = [
      "  How would you like to authenticate?",
      "  ❯ Login with email (recommended)",
      "    Enter API key manually",
      "  ↑/↓ to move, enter to choose",
    ].join("\n");

    test("offers a menu with the browser first, and folds it once chosen", async () => {
      const { out, asked, menus, opened, exitCode } = await runRf(
        ["init"],
        [started, pollThen(1), meAnswer],
        { terminal: person, answers: [0] },
      );
      expect(exitCode).toBeUndefined();
      expect(asked).toEqual([]);
      expect(menus).toEqual([
        menu,
        "  How would you like to authenticate? Login with email",
      ]);
      expect(out).toContain("◆ Welcome! Let's set up rf.");
      expect(opened).toEqual(["https://app.example.com/cli?code=HJKD-MPQR"]);
      expect(out).toContain(
        [
          "◆ Opening https://app.example.com/cli?code=HJKD-MPQR in your browser.",
          "  If it did not open, visit that address and enter HJKD-MPQR.",
          "  Waiting for approval...",
          "",
          "✓ Logged in as eddie@example.com",
        ].join("\n"),
      );
      expect(out).toContain(
        '  Get started:\n    rf remember "I prefer dark mode"',
      );
      expect((await stored()).profiles.default.apiKey).toBe(KEY);
    });

    test("takes a typed key, showing only its prefix, and checks it first", async () => {
      const { out, asked, menus, opened, seen } = await runRf(
        ["init"],
        [meAnswer],
        { terminal: person, answers: [1, `${KEY} `] },
      );
      expect(menus[1]).toBe(
        "  How would you like to authenticate? Enter API key manually",
      );
      // Eleven characters, as `rf whoami` shows, and an asterisk for each of the rest.
      expect(asked).toEqual([
        {
          question: "  API key: ",
          shown: `${KEY.slice(0, 11)}${"*".repeat(36)}`,
        },
      ]);
      expect(opened).toEqual([]);
      expect(routes(seen)).toEqual(["GET /api/v1/me"]);
      expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(out).toContain("◆ Checking the key...");
      expect(out).toContain("✓ Default collection: default (col_1)");
      // The key itself is never printed, only its prefix.
      expect(out).not.toContain(KEY);
      expect((await stored()).profiles.default.apiKey).toBe(KEY);
    });

    test("marks the highlight in colour where the terminal has it", async () => {
      const { menus } = await runRf(["init"], [], {
        terminal: { ...person, color: "256" },
        answers: [],
      });
      expect(menus[0]).toContain(
        "\x1b[38;5;75m❯ Login with email\x1b[39m \x1b[2m(recommended)\x1b[22m",
      );
      expect(menus[0]).toContain("\x1b[2m↑/↓ to move, enter to choose");
    });

    test("refuses a key the api does not accept, or none at all", async () => {
      const bad = await runRf(["init"], [refusedKey], {
        terminal: person,
        answers: [1, "rf_wrong"],
      });
      expect(bad.err).toBe(
        "The api did not accept that key, so nothing was stored.",
      );
      expect(bad.exitCode).toBe(1);
      const none = await runRf(["init"], [], {
        terminal: person,
        answers: [1, "  "],
      });
      expect(none.err).toBe("No key was entered, so nothing was stored.");
      expect(none.seen).toEqual([]);
      await expect(stat(env.credentialsFile)).rejects.toThrow();
    });

    test("stores nothing when the person leaves the menu or the key prompt", async () => {
      for (const answers of [[], [1]]) {
        const { err, exitCode, seen } = await runRf(["init"], [], {
          terminal: person,
          answers,
        });
        expect(err).toBe("Cancelled; nothing was stored.");
        expect(exitCode).toBe(130);
        expect(seen).toEqual([]);
      }
      await expect(stat(env.credentialsFile)).rejects.toThrow();
    });

    test("is not shown when stdin is not a terminal, which goes to the browser", async () => {
      const piped = await runRf(["init"], [started, pollThen(1), meAnswer], {
        terminal: wide,
      });
      expect(piped.menus).toEqual([]);
      expect(piped.asked).toEqual([]);
      expect(piped.opened).toHaveLength(1);
    });
  });

  describe("with a login already stored", () => {
    const OLD = "rf_" + "o".repeat(43);
    const overwrite =
      "  Overwrite existing config? This cannot be undone. [y/N] ";
    // Logs in by typing the old key, the way in that is not the browser.
    const storeOld = (args: string[] = []) =>
      runRf([...args, "init"], [meAnswer], {
        terminal: person,
        answers: [1, OLD],
      });

    test("asks before replacing it, and keeps it unless told yes", async () => {
      await storeOld();
      for (const answer of ["", "n", "no"]) {
        const { out, asked, seen, exitCode } = await runRf(["init"], [], {
          terminal: person,
          answers: [answer],
        });
        expect(out).toBe(
          [
            "",
            `  Existing configuration found (eddie@example.com, API key: ${OLD.slice(0, 11)}…)`,
            "◆ Cancelled. Use --force to skip this check.",
          ].join("\n"),
        );
        expect(asked.map((a) => a.question)).toEqual([overwrite]);
        expect(seen).toEqual([]);
        expect(exitCode).toBeUndefined();
      }
      expect((await stored()).profiles.default.apiKey).toBe(OLD);
    });

    test("replaces it when told yes", async () => {
      await storeOld();
      const { out, menus, exitCode } = await runRf(
        ["init"],
        [started, pollThen(1), meAnswer],
        { terminal: person, answers: ["y", 0] },
      );
      expect(exitCode).toBeUndefined();
      expect(menus).toHaveLength(2);
      expect(out).toContain("Living rent free in your AI agents");
      expect((await stored()).profiles.default.apiKey).toBe(KEY);
    });

    test("names the profile it belongs to, and leaves other profiles alone", async () => {
      await storeOld(["--profile", "work"]);
      const work = await runRf(["--profile", "work", "init"], [], {
        terminal: person,
        answers: ["n"],
      });
      expect(work.out).toContain(
        "  Existing configuration found for profile work (eddie@example.com, API key: rf_oooooooo…)",
      );
      const other = await runRf(["init"], [started, pollThen(1), meAnswer], {
        terminal: person,
        answers: [0],
      });
      expect(other.asked).toEqual([]);
      const profiles = (await stored()).profiles;
      expect(profiles.work.apiKey).toBe(OLD);
      expect(profiles.default.apiKey).toBe(KEY);
    });

    test("stores nothing when the person leaves the question", async () => {
      await storeOld();
      const { err, exitCode } = await runRf(["init"], [], {
        terminal: person,
        answers: [],
      });
      expect(err).toBe("Cancelled; nothing was stored.");
      expect(exitCode).toBe(130);
      expect((await stored()).profiles.default.apiKey).toBe(OLD);
    });

    test("refuses where nobody can answer, unless --force says to replace it", async () => {
      await storeOld();
      // A piped stdin, and a person who asked for JSON.
      const cases: Array<[string[], Terminal]> = [
        [["init"], wide],
        [["--json", "init"], person],
      ];
      for (const [args, terminal] of cases) {
        const { err, exitCode, seen } = await runRf(args, [], { terminal });
        expect(err).toBe(
          `A login is already stored for profile default (eddie@example.com, API key: ${OLD.slice(0, 11)}…). Pass --force to replace it.`,
        );
        expect(exitCode).toBe(1);
        expect(seen).toEqual([]);
      }
      const forced = await runRf(
        ["init", "--force"],
        [started, pollThen(1), meAnswer],
      );
      expect(forced.exitCode).toBeUndefined();
      expect((await stored()).profiles.default.apiKey).toBe(KEY);
    });
  });

  describe("the banner", () => {
    // A terminal that cannot be asked, so init goes to the browser.
    const signIn = (terminal: Terminal, args: string[] = []) =>
      runRf([...args, "init", "--force"], [started, pollThen(1), meAnswer], {
        terminal,
      });

    test("frames the name, the slogan, and the SDK's version", async () => {
      const { out } = await signIn(wide);
      const frame = out.split("\n").slice(0, 12);
      expect(frame[0]).toMatch(/^╭─+╮$/);
      expect(frame[1]).toMatch(/^╎ +╎$/);
      expect(frame[2]).toMatch(/^╎ {3}██████╗ ███████╗███╗ {3}██╗/);
      expect(frame[9]).toMatch(/^╎ {3}Living rent free in your AI agents +╎$/);
      expect(frame[11]).toMatch(/^╰─+ TypeScript SDK · v\S+ ──╯$/);
      expect(frame[11]).toContain(`v${sdk.version}`);
      expect(frame.map((line) => [...line].length)).toEqual(Array(12).fill(75));
      expect(out).toContain("◆ Welcome! Let's set up rf.");
      expect(out).toContain("✓ Logged in as eddie@example.com");
    });

    test("shrinks to one line on a terminal narrower than the frame", async () => {
      const { out } = await signIn({ ...wide, columns: 74 });
      expect(out.split("\n")[0]).toBe(
        `rentfree  Living rent free in your AI agents  v${sdk.version}`,
      );
      expect(out).not.toContain("█");
    });

    test("stays out of a pipe and --json", async () => {
      const pipe = await signIn({ ...wide, interactive: false });
      expect(pipe.out).not.toContain("Living rent free");
      expect(pipe.out).not.toContain("Get started");
      expect(pipe.out.split("\n")[0]).toBe(
        "Opening https://app.example.com/cli?code=HJKD-MPQR in your browser.",
      );
      const json = await signIn(wide, ["--json"]);
      expect(JSON.parse(json.out)).toMatchObject({ userId: "user_1" });
    });

    test("is coloured, as the marks are, where the terminal has colour", async () => {
      const { out } = await signIn({ ...wide, color: "256" });
      expect(out).toContain("\x1b[38;5;75m██████\x1b[39m\x1b[38;5;26m╗");
      expect(out).toContain(
        "\x1b[38;5;75mLiving rent free in your AI agents\x1b[39m",
      );
      expect(out).toContain("\x1b[2mTypeScript SDK");
      expect(out).toContain("\x1b[38;5;75m◆\x1b[39m Welcome!");
      expect(out).toContain("\x1b[32m✓\x1b[39m Logged in as eddie@example.com");
      const truecolor = await signIn({ ...wide, color: "truecolor" });
      expect(truecolor.out).toContain("\x1b[38;2;96;165;250m██████");
    });
  });
});

describe("rf logout", () => {
  const env = isolatedEnvironment();
  beforeEach(() => env.setup());
  afterEach(() => env.teardown());

  const loggedIn = () => runRf(["init"], [started, pollThen(1), meAnswer]);

  test("revokes the stored key and forgets it", async () => {
    await loggedIn();
    const { out, seen, exitCode } = await runRf(
      ["logout"],
      [
        meAnswer,
        { method: "DELETE", path: "/api/v1/keys/key_1", body: { id: "key_1" } },
      ],
    );
    expect(exitCode).toBeUndefined();
    expect(routes(seen)).toEqual([
      "GET /api/v1/me",
      "DELETE /api/v1/keys/key_1",
    ]);
    expect(out).toBe(`Logged out. Key ${KEY.slice(0, 11)}… revoked.`);
    const stored = JSON.parse(await readFile(env.credentialsFile, "utf8"));
    expect(stored.profiles).toEqual({});
    expect((await runRf(["whoami"], [])).err).toContain("Not logged in");
  });

  test("still forgets the key when the api cannot revoke it, and says so", async () => {
    await loggedIn();
    const { out } = await runRf(["logout"], [refusedKey]);
    expect(out).toContain("could not be revoked");
    const stored = JSON.parse(await readFile(env.credentialsFile, "utf8"));
    expect(stored.profiles).toEqual({});
  });

  test("is harmless with nothing stored", async () => {
    const { out, exitCode } = await runRf(["logout"], []);
    expect(out).toBe("No login stored.");
    expect(exitCode).toBeUndefined();
  });
});
