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
preverified_computation_executor="${OVERCENTER_PREVERIFIED_COMPUTATION_EXECUTOR:-0}"
keep_build="${OVERCENTER_KEEP_BUILD:-0}"

case "$preverified_computation_executor:$keep_build" in
  0:0|0:1|1:0|1:1) ;;
  *) echo "invalid production-proof reuse flags" >&2; exit 2 ;;
esac

test "$(go env GOVERSION)" = "go${go_version}"
rm -rf "$build_dir"
mkdir -p "$build_dir"
if [[ "$keep_build" != "1" ]]; then
  trap 'rm -rf "$build_dir"' EXIT
fi

(
  cd executor
  go test ./...
  CGO_ENABLED=0 go build -trimpath -buildvcs=false -o "../$build_dir/overcenter-executor" ./cmd/overcenter-executor
)

if [[ "$preverified_computation_executor" != "1" ]]; then
  npm run test:computation-executor
fi

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
