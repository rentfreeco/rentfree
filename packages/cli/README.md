# rentfree

Memory for AI agents, from the terminal. An agent logs what it sees and what you give it; rentfree turns that into searchable, attributable memories and hands back the right context for its next turn, within a token budget.

```sh
npm install -g @rentfree/cli
rf init                       # opens the browser; a first sign-in is a sign-up
rf agents create claude-code --use
rf hooks install              # Claude Code starts each session with its memory
```

The binary is `rf`. It is one file with no dependencies and starts in about 60 ms, so an agent can call it on every turn.

This package used to be `rentfree`. If you have that installed, remove it first with `npm uninstall -g rentfree`: both install `rf`, and npm will not install one over the other.

## What it does

| Command                                  | For                                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| `rf context [query]`                     | The context pack for an agent's next turn, as prompt-ready text |
| `rf search <query>`                      | Memories and document passages, by meaning and by words         |
| `rf remember <text>`                     | Write a memory                                                  |
| `rf memories …`                          | List, show, correct, archive, and trace memories                |
| `rf sources add <path \| url>`           | Add a document; adding it again updates it                      |
| `rf session start`, `rf log`             | Log a conversation as it happens                                |
| `rf recap run`                           | Turn logged events into memories                                |
| `rf hooks install`                       | Wire all of it into Claude Code, with no tokens spent           |
| `rf keys`, `rf agents`, `rf collections` | Manage the account                                              |

Text output is written for a model to read; `--json` is for scripts. A failure is one line on stderr and exit code 1.

## Documentation

[rentfree.dev/docs](https://rentfree.dev/docs): getting started, the Claude Code hooks, the full CLI reference, and the API reference.

The typed client this CLI is built on is [`@rentfree/sdk`](https://www.npmjs.com/package/@rentfree/sdk).

## Licence

MIT.
