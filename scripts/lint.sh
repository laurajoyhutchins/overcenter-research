#!/usr/bin/env bash
set -euo pipefail

BIOME_VERSION=2.5.14

# Lint TypeScript and JSON, including contract/evidence JSON, without rewriting bytes.
npx --yes "@biomejs/biome@$BIOME_VERSION" lint .

# Formatting remains scoped to handwritten TypeScript plus the two project config files.
mapfile -t biome_format_files < <(
  git ls-files '*.ts' biome.json package.json \
    | grep -v '^src/generated/' \
    | grep -v '^src/providers/github/operations\.generated\.ts$'
)
npx --yes "@biomejs/biome@$BIOME_VERSION" format "${biome_format_files[@]}"

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
