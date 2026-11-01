# Contributing

Thanks for looking. Bug reports, ideas, and pull requests are all welcome.

## Issues

For a bug, say which command you ran, what it printed, and what you expected; `rf --version` and your Node.js version help. Leave out your API key: `rf whoami` shows only its prefix, which is enough.

## Pull requests

This repository is a copy. The CLI and SDK are developed beside the rentfree service in a private repository, and each change to them arrives here as one commit. So a pull request is not merged here, where the next copy would replace it: it is applied in the private repository, keeping you as the author, and arrives here with the next copy. The pull request is closed then, with a link to that commit.

Before opening one:

```
pnpm install
pnpm lint
pnpm check-types
pnpm test
```

CI runs the same, and builds both packages.

Commit messages read `type(scope): subject`, such as `fix(cli): keep the profile when login fails`, with the type one of `feat`, `fix`, `docs`, `chore`, `refactor`, or `test`, and the scope `cli` or `sdk`.

The SDK's contract, in `packages/sdk/src/contract`, describes the API the service implements. A change there needs the service to change with it, so open an issue first.

## Releasing

For maintainers. `rentfree` and `@rentfree/sdk` are released together, at one version, by `.github/workflows/release.yml` when a tag like `v0.0.2` is pushed here. The workflow checks that the tag matches both versions, lints, type-checks, and tests the two packages, packs them with pnpm, and publishes each tarball through npm's trusted publishing, with a provenance statement. A version npm already has is skipped rather than failed, by `.github/scripts/publish-once.sh`, so a run is safe to repeat. A second job then creates the GitHub release, with notes from the pull requests since the last tag.

To release:

1. In the private repository, bump `version` in `packages/cli/package.json` and `packages/sdk/package.json`, run `pnpm --filter @rentfree/sdk openapi` so the OpenAPI document carries it, and merge. The change arrives here.
2. Here, tag that commit and push the tag:

   ```
   git tag v0.0.2 && git push origin v0.0.2
   ```

npm trusts this workflow because each package's settings name it as a trusted publisher: GitHub Actions, the owner `rentfreeco`, the repository `rentfree`, the workflow `release.yml`, and the environment `npm`. No npm token exists anywhere. A failed run can be started again from the Actions tab; what already succeeded is skipped.
