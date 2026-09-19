#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

image="${OVERCENTER_EXECUTOR_IMAGE:-overcenter-executor-production-proof:${GITHUB_SHA:-local}}"
name="${OVERCENTER_EXECUTOR_CONTAINER_NAME:-overcenter-executor-containment-$$}"
owned_work=0
if [[ -n "${OVERCENTER_EXECUTOR_WORKDIR:-}" ]]; then
  work="$OVERCENTER_EXECUTOR_WORKDIR"
  rm -rf "$work"
  mkdir -p "$work"
else
  work="$(mktemp -d)"
  owned_work=1
fi

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [[ "$owned_work" == "1" ]]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT

(
  cd executor
  go test ./...
)

npm run test:computation-executor

docker build -f executor/containment/Dockerfile -t "$image" .

OVERCENTER_EXECUTOR_IMAGE="$image" \
  node --experimental-strip-types --test test/computation-container.test.ts

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d \
  --name "$name" \
  --network=none \
  --read-only \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL \
  --cap-add=CHOWN \
  --cap-add=DAC_OVERRIDE \
  --cap-add=KILL \
  --cap-add=SETGID \
  --cap-add=SETUID \
  --pids-limit=64 \
  --memory=512m \
  --memory-swap=512m \
  --cpus=1 \
  --ulimit=nofile=256:256 \
  --ulimit=fsize=67108864:67108864 \
  -v "$work:/workspace" \
  "$image" >/dev/null

for _ in $(seq 1 100); do
  if [[ -f "$work/executor-killed" ]]; then
    break
  fi
  sleep 0.1
done

test -f "$work/credential-proof"
test -f "$work/executor-killed"
grep -Fx 'executor=0 task=65532 groups=65532' "$work/credential-proof"

docker top "$name" -eo pid,ppid,cmd
mapfile -t pids < <(docker top "$name" -eo pid | tail -n +2 | tr -d ' ')
if [[ "${#pids[@]}" -lt 2 ]]; then
  echo "expected worker driver plus hostile survivor after executor SIGKILL" >&2
  exit 1
fi

docker kill "$name" >/dev/null
for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "container teardown left host process alive: $pid" >&2
    exit 1
  fi
done
docker rm "$name" >/dev/null

npm test
