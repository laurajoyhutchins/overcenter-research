#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

root="$tmp/task-root"
outside="$tmp/outside"
launcher="$tmp/landlock-launcher"

mkdir -p "$root" "$outside"
printf 'SAFE\n' > "$root/input.txt"
printf 'SECRET\n' > "$outside/secret.txt"
printf 'UNCHANGED\n' > "$outside/write-target.txt"
cp "$here/worker.mjs" "$root/worker.mjs"

echo "== control: ordinary Node can read outside the task root =="
test "$(node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').trim())" "$outside/secret.txt")" = "SECRET"

echo "== compile Rust Landlock launcher =="
rustc --edition=2021 -D warnings "$here/launcher.rs" -o "$launcher"

echo "== launch an ordinary Node worker inside the Landlock domain =="
"$launcher" \
  "$root" \
  /usr/bin/node \
  "$root/worker.mjs" \
  "$root/input.txt" \
  "$outside/secret.txt" \
  "$root/output.txt" \
  "$outside/write-target.txt"

echo "== verify durable effects =="
test "$(cat "$root/output.txt")" = "TASK-WRITE"
test "$(cat "$outside/secret.txt")" = "SECRET"
test "$(cat "$outside/write-target.txt")" = "UNCHANGED"

echo
echo "PASS: child process inherited kernel-enforced task filesystem confinement"
