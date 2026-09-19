#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

image="overcenter-executor-production-proof:${GITHUB_SHA:-local}"
go_image="$(node -e "const x=require('./executor/runtime-images.json'); process.stdout.write(x.go_build)")"
node_image="$(node -e "const x=require('./executor/runtime-images.json'); process.stdout.write(x.node_runtime)")"

(
  cd executor
  go test ./...
)

npm run test:computation-executor

docker build \
  --build-arg GO_IMAGE="$go_image" \
  --build-arg NODE_IMAGE="$node_image" \
  -f executor/containment/Dockerfile \
  -t "$image" \
  .

OVERCENTER_EXECUTOR_IMAGE="$image" \
  node --experimental-strip-types --test test/computation-container.test.ts

node --experimental-strip-types bin/prove-computation-containment.ts \
  --image "$image"

npm test
