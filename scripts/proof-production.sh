#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

image="overcenter-executor-production-proof:${GITHUB_SHA:-local}"
go_version="$(tr -d '\r\n' < .go-version)"
node_version="$(tr -d '\r\n' < .node-version)"

(
  cd executor
  go test ./...
)

npm run test:computation-executor

docker build \
  --build-arg GO_VERSION="$go_version" \
  --build-arg NODE_VERSION="$node_version" \
  -f executor/containment/Dockerfile \
  -t "$image" \
  .

OVERCENTER_EXECUTOR_IMAGE="$image" \
  node --experimental-strip-types --test test/computation-container.test.ts

node --experimental-strip-types bin/prove-computation-containment.ts \
  --image "$image"

npm test
