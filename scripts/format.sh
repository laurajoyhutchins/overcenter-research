#!/usr/bin/env bash
set -euo pipefail

BIOME_VERSION=2.5.14

mapfile -t biome_format_files < <(
  git ls-files '*.ts' biome.json package.json \
    | grep -v '^src/generated/' \
    | grep -v '^src/providers/github/operations\.generated\.ts$'
)
npx --yes "@biomejs/biome@$BIOME_VERSION" format --write "${biome_format_files[@]}"

gofmt -w src/execution/executor
find src experiments -name '*.rs' -print0 | xargs -0 -n 1 rustfmt
