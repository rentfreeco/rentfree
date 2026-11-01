#!/usr/bin/env bash
# Usage: publish-once.sh <package name> <tarball>
#
# Publishes a packed package to npm with a provenance statement, unless npm
# already has that version, in which case it says so and succeeds. That
# makes a release run safe to repeat, and lets a version published by hand
# be tagged afterwards.
set -euo pipefail

name="$1"
tarball="$2"
version="$(tar -xOzf "$tarball" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"

# `npm view` prints the version when it exists, and fails with E404 when
# the package or the version does not.
if published="$(npm view "$name@$version" version 2>/dev/null)" && [ "$published" = "$version" ]; then
  echo "$name@$version is on npm already; skipping."
  exit 0
fi

npm publish "$tarball" --access public --provenance
