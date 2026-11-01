# rentfree CLI

The command line for [rentfree](https://rentfree.dev): memory for AI agents. An agent logs what it sees and what you give it; rentfree turns that into searchable, attributable memories and hands back the right context for its next turn, within a token budget.

> **Built for agents to call.** Text output is written for a model to read, so an agent can put it straight into its prompt. Add `--json` to any command for the api's own response, for scripts. `rf` is one file with no dependencies and starts in about 60 ms, so an agent can call it on every turn.

## Prerequisites

- Node.js **20** or later
- A rentfree account. You need not make one first: the first `rf init` is a sign-up.

## Installation

```sh
npm install -g @rentfree/cli
```

The binary is `rf`.

This package used to be `rentfree`. If you have that installed, remove it first with `npm uninstall -g rentfree`: both install `rf`, and npm will not install one over the other.

## Quick start

```sh
# Sign in through the browser; a first sign-in is a sign-up
rf init

# Give Claude Code its own agent in this project, with a key of its own
rf agents create claude-code --use

# Wire rentfree into Claude Code: each session starts with its memory
rf hooks install

# Write a memory
rf remember "Deploys go out from main, once CI is green." --type decision

# Add a document, and wait until it can be searched
rf sources add ./docs/runbook.md --wait

# Find memories and document passages
rf search "how do we deploy?"

# The context pack for an agent's next turn
rf context "how do we deploy?" --budget 1500
```

## How it fits together

Everything lives in a **collection**. An agent logs a **session** as it happens, one event at a time. Ending the session starts a **recap**, which turns its events into **memories** and rewrites the collection's **profile**, a standing summary. You can also write memories yourself, and add **sources**: files, URLs, or text, split into passages. `rf context` and `rf search` read all of it back.

An **agent** is an identity with its own keys and permissions, such as read-only or a few collections, so what Claude Code writes is attributed to it and it can do no more than you let it.

## Commands

Each command below also takes the [global flags](#global-flags).

### `rf init`

Sign in, and store the key. At a terminal, it asks how: through the browser, or by typing a key in. A pipe or `--json` is asked nothing and goes to the browser. `rf login` is the same command.

```sh
rf init
rf init --profile work
rf init --force
```

A login already stored for the profile is kept unless you agree to replace it, or pass `--force`. On a machine with no browser, set `RF_API_KEY` instead.

| Flag      | Description                                                    |
| --------- | -------------------------------------------------------------- |
| `--force` | Replace a login already stored for this profile without asking |

### `rf whoami`, `rf logout`

`rf whoami` says who the current key belongs to, and what it can see. `rf logout` revokes the stored key and forgets it.

```sh
rf whoami
rf logout
```

### `rf context`

The context pack for an agent's next turn: the profile, the memories, and the document passages that matter for the query, rendered as text for a prompt and kept within the token budget. Without a query, the profile and the most important memories.

```sh
rf context "how do we deploy?"
rf context --budget 4000
rf context "release checklist" --collection <id> --json
```

| Flag           | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `--budget`     | Most tokens the pack may use, 200 to 16000                               |
| `--collection` | The collection to use; otherwise `rf.json`'s, then the account's default |

### `rf search`

Find memories and document passages, by meaning and by words.

```sh
rf search "deploy"
rf search "deploy" --kind memory --type decision,plan
rf search "rollback" --kind chunk --limit 5
```

| Flag           | Description                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| `--collection` | Collection ids to search, comma-separated; otherwise every one the key may read |
| `--kind`       | Only memories (`memory`) or only document passages (`chunk`)                    |
| `--type`       | Only memories of these types, comma-separated                                   |
| `--tier`       | Only memories in these tiers, comma-separated                                   |
| `--limit`      | Most hits of each kind, 1 to 50                                                 |

### `rf remember`

Write a memory. `-` reads it from stdin.

```sh
rf remember "Deploys need green CI." --type decision
rf remember "Ana prefers small pull requests." --type preference --subject Ana
rf remember "Staging is down for maintenance." --tier working --expires 2026-11-02T09:00:00Z
git log -1 --format=%B | rf remember -
```

| Flag           | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `--type`       | `fact`, `preference`, `decision`, `plan`, or your own                    |
| `--tier`       | `long` lasts and fades slowly; `working` expires, in a day by default    |
| `--subject`    | What it is about, such as a person or a project                          |
| `--importance` | 0 to 1; 0.5 when left out                                                |
| `--expires`    | For a working memory: when it expires, ISO 8601, within 30 days          |
| `--collection` | The collection to use; otherwise `rf.json`'s, then the account's default |

### `rf memories`

List, show, correct, archive, and trace memories. A corrected text is a new version; an archived memory keeps its history and sources, and can be restored.

```sh
rf memories list --status archived --limit 20
rf memories show <id>
rf memories edit <id> --content "Deploys need green CI and a review."
rf memories archive <id>
rf memories restore <id>
rf memories history <id>     # every change, newest first
rf memories sources <id>     # where it came from
```

| Flag           | Command | Description                                                              |
| -------------- | ------- | ------------------------------------------------------------------------ |
| `--status`     | `list`  | `active` (the default), `archived`, or `expired`                         |
| `--limit`      | `list`  | Most to show, 1 to 100                                                   |
| `--collection` | `list`  | The collection to use; otherwise `rf.json`'s, then the account's default |
| `--content`    | `edit`  | The corrected text; `-` reads it from stdin                              |
| `--subject`    | `edit`  | What it is about                                                         |
| `--importance` | `edit`  | 0 to 1                                                                   |

### `rf profile`

A collection's profile, as recap last wrote it.

```sh
rf profile
rf profile --collection <id>
```

### `rf session`, `rf log`

Log a conversation as it happens. `rf session start` prints the session's id; the same `--external-id` always finds the same session, so a retry or a second process does not start another. Ending a session starts a recap.

```sh
id=$(rf session start --title "Fix the flaky deploy" --external-id my-agent:run-42)

rf log "$id" --type message.user --content "How do we deploy?"
echo "From main, once CI is green." | rf log "$id" --type message.assistant
rf log "$id" --type tool.call --content "gh run list" --meta tool=bash

# Many events at once, one JSON object a line
printf '%s\n' '{"type":"note","content":"CI was red twice"}' | rf log "$id" --batch

rf session end "$id"
rf session list --limit 10
rf session show "$id"
rf session events "$id"
```

| Flag            | Command          | Description                                                                   |
| --------------- | ---------------- | ----------------------------------------------------------------------------- |
| `--title`       | `start`, `end`   | What the session is about                                                     |
| `--external-id` | `start`          | Your own id for this run; the same one always finds the same session          |
| `--collection`  | `start`, `list`  | The collection to use; otherwise `rf.json`'s, then the account's default      |
| `--limit`       | `list`, `events` | Most to show, 1 to 100                                                        |
| `--type`        | `log`            | `message.user`, `message.assistant`, `tool.call`, `tool.result`, or `note`    |
| `--content`     | `log`            | The event's text; otherwise read from stdin                                   |
| `--meta`        | `log`            | Metadata, as `key=value`; repeat for more                                     |
| `--batch`       | `log`            | Read many events from stdin, one JSON object a line: `{"type":…,"content":…}` |

### `rf sources`

Add documents for `rf search` and `rf context` to find passages in: a file, an http(s) URL, or text on stdin. Adding the same one again updates it.

```sh
rf sources add ./docs/runbook.md --wait
rf sources add https://example.com/handbook --title "Handbook"
pbpaste | rf sources add - --title "Meeting notes" --external-id notes:2026-10-31
rf sources list
rf sources show <id>         # with its ingest status
rf sources content <id>      # a ready source's text
rf sources refresh <id> --wait
rf sources remove <id>
```

| Flag            | Command          | Description                                                              |
| --------------- | ---------------- | ------------------------------------------------------------------------ |
| `--title`       | `add`            | What to call it; a file is named after itself                            |
| `--external-id` | `add`            | Your own name for it; otherwise the file's full path, or the URL         |
| `--wait`        | `add`, `refresh` | Wait until it is ready, or has failed                                    |
| `--collection`  | `add`, `list`    | The collection to use; otherwise `rf.json`'s, then the account's default |
| `--limit`       | `list`           | Most to show, 1 to 100                                                   |

### `rf recap`

Turn logged events into memories. Ending a session starts one on its own; `rf recap run` recaps every event not yet read.

```sh
rf recap run --wait
rf recap runs --limit 5
rf recap show <id>
```

| Flag      | Command | Description                                       |
| --------- | ------- | ------------------------------------------------- |
| `--wait`  | `run`   | Wait for the run to finish, and print what it did |
| `--limit` | `runs`  | Most to show, 1 to 100                            |

### `rf hooks`

Wire rentfree into Claude Code's hooks, so every session is logged and starts with its memory. The hooks call the api, not a model, so they spend no tokens. A hook that fails prints one line to stderr and exits 0: it never blocks Claude Code.

```sh
rf hooks install
rf hooks install --scope user --tools --recall --budget 2000
rf hooks status
rf hooks uninstall --scope user
```

| Claude Code event  | What `rf` does                                                    |
| ------------------ | ----------------------------------------------------------------- |
| `SessionStart`     | Adds a context pack to the session                                |
| `UserPromptSubmit` | Logs the prompt; with `--recall`, also adds a context pack for it |
| `Stop`             | Logs Claude's reply                                               |
| `SessionEnd`       | Ends the rentfree session, which starts a recap                   |
| `PostToolUse`      | With `--tools` only: logs every tool call and its result          |

| Flag       | Command                | Description                                                                                                                                       |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope`  | `install`, `uninstall` | `project`: `.claude/settings.json`, shared; `local`: `.claude/settings.local.json`, yours alone; `user`: `~/.claude/settings.json`, every project |
| `--tools`  | `install`              | Also log every tool call and its result                                                                                                           |
| `--recall` | `install`              | Also fetch a context pack for every prompt, not only at the start                                                                                 |
| `--budget` | `install`              | Most tokens a context pack may use                                                                                                                |

Installing again replaces rentfree's hooks; uninstalling removes them and only them, and leaves the rest of the settings file as it was.

### `rf agents`

Agents: identities with their own keys and permissions. `--use` also mints a key for the new agent, stores it, and writes its id to `rf.json`, so Claude Code and its hooks act as it in this project.

```sh
rf agents create claude-code --use
rf agents create reviewer --read-only --collections <id>,<id>
rf agents list
rf agents edit <id> --name reviewer-bot --read-write
rf agents revoke <id>        # and every key it holds
```

| Flag            | Command          | Description                                                                                |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `--read-only`   | `create`, `edit` | Let the agent read but not write                                                           |
| `--read-write`  | `edit`           | Let the agent write again                                                                  |
| `--collections` | `create`, `edit` | Collection ids the agent may use, comma-separated                                          |
| `--name`        | `edit`           | A new name                                                                                 |
| `--use`         | `create`         | Also mint a key for the agent, store it, and make Claude Code and its hooks act as it here |
| `--revoked`     | `list`           | Show revoked agents instead of live ones                                                   |

### `rf keys`

API keys. A key's secret is shown once, when it is minted.

```sh
rf keys create --name "CI on GitHub"
rf keys create --name claude-code --agent <id> --use
rf keys list
rf keys revoke <id-or-prefix>
```

| Flag        | Command  | Description                                                                            |
| ----------- | -------- | -------------------------------------------------------------------------------------- |
| `--name`    | `create` | What the key is for, such as "CI on GitHub". Required                                  |
| `--agent`   | `create` | Mint the key for this agent; without it, a user-level key                              |
| `--use`     | `create` | With `--agent`: store the key and make Claude Code and its hooks act as its agent here |
| `--revoked` | `list`   | Show revoked keys instead of live ones                                                 |

### `rf collections`

```sh
rf collections list
rf collections create "Side project"
rf collections rename <id> "Main project"
rf collections set-default <id>
rf collections archive <id>  # it stays readable
```

| Flag         | Command | Description                                      |
| ------------ | ------- | ------------------------------------------------ |
| `--archived` | `list`  | Show archived collections instead of active ones |

### `rf config`

What commands here run with, and the settings that change it. `rf config set collection` and `rf config set agent` write to the project's `rf.json`.

```sh
rf config show                                    # the api, the key and where it came from, the collection, the agent
rf config set collection <id>                     # this project's default collection
rf config set agent <id>                          # the agent Claude Code and its hooks act as here
rf config set embed-model openai/text-embedding-3-large@1024
```

The embedding model can be changed only while the account has no content yet.

### `rf account`

```sh
rf account delete --confirm you@example.com
```

Deletes the account and everything in it: every collection, memory, source, agent, and key. It cannot be undone. Without `--confirm` and the account's email typed back, it only says what it would delete.

## For agents and scripts

- **Text is for models.** The default output is short and aligned, with no colour, spinner, or decoration, so it reads well in a prompt. Only `rf init`, at a terminal, is laid out for a person.
- **`--json` is for scripts.** It prints the api's response as it is, so it pipes into `jq`. Under `--json`, `rf init` writes its progress to stderr, so stdout stays one object.
- **A failure is one line.** It goes to stderr, with exit code 1 and no stack trace, under `--json` too. A cancelled `rf init` exits 130.
- **Agents act as themselves.** When Claude Code runs `rf`, a hook runs it, or `RF_AGENT=1` is set, `rf` uses the key of the agent `rf.json` names, so the agent can do no more than it may. You, at a terminal of your own, keep your own login in the same project. When the api refuses an agent, the message says whose key was used.

```sh
# The text an agent puts in its prompt
rf context "$PROMPT" --budget 1500 --json | jq -r .text

# The decisions that match, one a line: id, then text
rf search "deploy" --kind memory --type decision --json | jq -r '.memories[] | "\(.id)  \(.content)"'
```

`rf context --json` returns the pack: `text`, the rendered pack; `tokenCount` and `tokenBudget`; `mode`; and the `profile`, `memories`, and `chunks` it was made from. `rf search --json` returns `mode`, `memories`, and `chunks`, each hit with its `score`.

## Global flags

These work with every command, before or after it.

| Flag                    | Description                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| `--json`                | Print JSON instead of text, for scripts                                      |
| `--api-url <url>`       | The api to talk to; otherwise `RF_API_URL`, then the address stored at login |
| `--profile <name>`      | Which stored login to use; `default` when left out                           |
| `-h, --help`            | Help for any command, such as `rf sources add --help`                        |
| `-v, --version`         | The version of `rf`                                                          |
| `--completions <shell>` | Print a completion script for `bash`, `zsh`, `fish`, `sh`, or `powershell`   |

## Environment variables

| Variable          | Description                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `RF_API_KEY`      | A key to use instead of any stored one: for CI, and machines with no browser             |
| `RF_API_URL`      | The api to talk to, when `--api-url` is not given                                        |
| `RF_AGENT`        | `1`, `true`, or `yes`: an agent is running `rf`, so it acts as the agent `rf.json` names |
| `XDG_CONFIG_HOME` | Where `rf/credentials.json` is kept; `~/.config` when unset                              |

The key is `RF_API_KEY` if it is set; else, when an agent is running `rf`, the stored key of the agent `rf.json` names; else the profile's login. The api is `--api-url`, then `RF_API_URL`, then the address stored at login, then `https://api.rentfree.dev`.

## Files

| File                            | What it holds                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/rf/credentials.json` | Your logins, one per `--profile`, and the keys of agents you `--use`. Readable by you alone; never commit it                                |
| `rf.json`                       | The project's collection and agent, by id, never a secret, so it can be committed. `rf` uses the nearest one, from the working directory up |

## Development

The source is in [rentfreeco/rentfree](https://github.com/rentfreeco/rentfree), beside the SDK. From the repository's root, with Node.js 24 and pnpm through Corepack:

```sh
corepack enable
pnpm install
pnpm build
pnpm test

# Run the CLI you just built
node packages/cli/dist/rf.mjs --help
```

It talks to `https://api.rentfree.dev` unless `--api-url`, `RF_API_URL`, or the address stored at login says otherwise. Issues and pull requests are welcome; [CONTRIBUTING.md](https://github.com/rentfreeco/rentfree/blob/main/CONTRIBUTING.md) explains how a change gets in.

## Documentation

[rentfree.dev/docs](https://rentfree.dev/docs): getting started, the Claude Code hooks, the full CLI reference, and the API reference.

The typed client this CLI is built on is [`@rentfree/sdk`](https://www.npmjs.com/package/@rentfree/sdk).

## Licence

MIT.
