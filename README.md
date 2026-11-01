# rentfree

Memory for AI agents, from the terminal. An agent logs what it sees and what you give it; rentfree turns that into searchable, attributable memories and hands back the right context for the next turn, within a token budget.

```
npm install -g @rentfree/cli
rf init
```

`rf init` opens your browser to sign in, or sign up, and the terminal has a key. Then `rf hooks install` in a project gives Claude Code a memory of every session there. The [docs](https://rentfree.dev/docs) cover the rest.

## What is here

| Path                                                   | What it is                                                                           | On npm                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `packages/cli`                                         | `rf`, the command line                                                               | [`@rentfree/cli`](https://www.npmjs.com/package/@rentfree/cli) |
| `packages/sdk`                                         | The API's contract, its OpenAPI document, and the TypeScript client `rf` is built on | [`@rentfree/sdk`](https://www.npmjs.com/package/@rentfree/sdk) |
| `packages/eslint-config`, `packages/typescript-config` | The configs both build with                                                          |                                                                |

The rentfree service itself is not in this repository.

## Developing

Node.js 24 and pnpm, through Corepack:

```
corepack enable
pnpm install
pnpm build
pnpm test
```

`node packages/cli/dist/rf.mjs --help` runs the CLI you just built. It talks to `https://api.rentfree.dev` unless `--api-url`, `RF_API_URL`, or the address saved at login says otherwise.

## How this repository is kept

The CLI and SDK are developed beside the service, in a private repository, and every change to them is copied here as one commit. Issues and pull requests are welcome here. A pull request is applied in the private repository and comes back with the next copy, credited to you, rather than merged here, where the next copy would replace it. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## Releases

Both packages are released together, at one version, from this repository. Each release's notes are on the [releases page](https://github.com/rentfreeco/rentfree/releases).

## License

[MIT](LICENSE)
