#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo_root/experiments/effect-authority-decay"
baseline_sha="81b350e526824ab2c397642e6761a0c860151331"
tmp="$(mktemp -d)"
trap 'git -C "$repo_root" worktree remove --force "$tmp/baseline" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

git -C "$repo_root" worktree add --detach "$tmp/baseline" "$baseline_sha" >/dev/null

run_one() {
  local dir="$1"
  local out="$2"
  (
    cd "$dir"
    node --experimental-strip-types experiments/production-latency/benchmark.ts --iterations 25 > "$out"
  )
}

run_one "$tmp/baseline" "$tmp/b1.json"
run_one "$repo_root" "$tmp/t1.json"
run_one "$repo_root" "$tmp/t2.json"
run_one "$tmp/baseline" "$tmp/b2.json"
run_one "$tmp/baseline" "$tmp/b3.json"
run_one "$repo_root" "$tmp/t3.json"

node "$here/benchmark-compare.mjs"   "$tmp/b1.json" "$tmp/t1.json" "$tmp/t2.json"   "$tmp/b2.json" "$tmp/b3.json" "$tmp/t3.json"
