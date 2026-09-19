#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
image="${OVERCENTER_EXECUTOR_IMAGE:-overcenter-executor-production-proof:${GITHUB_SHA:-local}}"
go_version="$(tr -d '[:space:]' < .go-version)"
node_version="$(tr -d '[:space:]' < .node-version)"
actual_go="$(go version | awk '{print $3}' | sed 's/^go//')"
actual_node="$(node -p 'process.versions.node')"
if [[ "$actual_go" != "$go_version" ]]; then
  echo "proof:production requires Go $go_version, got $actual_go" >&2
  exit 2
fi
if [[ "$actual_node" != "$node_version" ]]; then
  echo "proof:production requires Node $node_version, got $actual_node" >&2
  exit 2
fi
(cd executor && go test ./...)
npm run test:computation-executor
docker build \
  --build-arg "GO_VERSION=$go_version" \
  --build-arg "NODE_VERSION=$node_version" \
  -f executor/containment/Dockerfile -t "$image" .
OVERCENTER_EXECUTOR_IMAGE="$image" node --experimental-strip-types --test test/computation-container.test.ts
npm test
