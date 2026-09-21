#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "usage: $0 SOURCE_SHA IMAGE REPORT" >&2
  exit 64
fi

source_sha="$1"
image="$2"
report="$3"
go_version="$(tr -d '\r\n' < .go-version)"

test "$(go env GOVERSION)" = "go${go_version}"

reuse_executor="${OVERCENTER_REUSE_EXECUTOR:-0}"
case "$reuse_executor" in
  0|1) ;;
  *) echo "invalid self-application executor reuse flag" >&2; exit 64 ;;
esac

if [[ "$reuse_executor" == "1" ]]; then
  test -x .overcenter-build/overcenter-executor
else
  rm -rf .overcenter-build
  mkdir -p .overcenter-build
  (
    cd executor
    CGO_ENABLED=0 go build -trimpath -buildvcs=false \
      -o ../.overcenter-build/overcenter-executor \
      ./cmd/overcenter-executor
  )
fi

docker build \
  --build-arg NODE_IMAGE="$(node -e "const x=require('./executor/runtime-images.json'); process.stdout.write(x.node_self_application)")" \
  --build-arg NODE_VERSION="$(cat .node-version)" \
  -f executor/self-application/Dockerfile \
  -t "$image" \
  .

node --experimental-strip-types bin/self-application-evidence.ts \
  --image "$image" \
  --source-sha "$source_sha" \
  --report "$report"
