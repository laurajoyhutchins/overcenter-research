#!/usr/bin/env bash
set -euo pipefail

BIOME_VERSION=2.5.14

npx --yes "@biomejs/biome@$BIOME_VERSION" format --write .
gofmt -w src/execution/executor
find src experiments -name '*.rs' -print0 | xargs -0 -n 1 rustfmt
