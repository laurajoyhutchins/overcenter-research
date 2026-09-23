#!/usr/bin/env bash
set -euo pipefail

BIOME_VERSION=2.5.14

npx --yes "@biomejs/biome@$BIOME_VERSION" ci .

go_unformatted="$(gofmt -l src/execution/executor)"
if [[ -n "$go_unformatted" ]]; then
  printf 'gofmt required:\n%s\n' "$go_unformatted" >&2
  exit 1
fi
(
  cd src/execution/executor
  go vet ./...
)

find src experiments -name '*.rs' -print0 | xargs -0 -n 1 rustfmt --check
