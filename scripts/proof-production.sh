#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ "$#" -gt 1 || ( -n "$mode" && "$mode" != "--boundary-only" ) ]]; then
  echo "usage: $0 [--boundary-only]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

image="overcenter-executor-production-proof:${GITHUB_SHA:-local}"
go_version="$(tr -d '\r\n' < .go-version)"
node_version="$(tr -d '\r\n' < .node-version)"
node_image="$(node -e "const x=require('./executor/runtime-images.json'); process.stdout.write(x.node_runtime)")"
build_dir=".overcenter-build"

test "$(go env GOVERSION)" = "go${go_version}"
rm -rf "$build_dir"
mkdir -p "$build_dir"
trap 'rm -rf "$build_dir"' EXIT

(
  cd executor
  go test ./...
  CGO_ENABLED=0 go build -trimpath -buildvcs=false -o "../$build_dir/overcenter-executor" ./cmd/overcenter-executor
)

npm run test:computation-executor

docker build \
  --build-arg NODE_IMAGE="$node_image" \
  --build-arg NODE_VERSION="$node_version" \
  -f executor/containment/Dockerfile \
  -t "$image" \
  .

OVERCENTER_EXECUTOR_IMAGE="$image" \
  node --experimental-strip-types --test test/computation-container.test.ts

node --experimental-strip-types bin/prove-computation-containment.ts \
  --image "$image"

npm run proof:rust-exec

if [[ "$mode" != "--boundary-only" ]]; then
  npm test
fi
