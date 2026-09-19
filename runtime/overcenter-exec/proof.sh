#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo_root/runtime/overcenter-exec"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

launcher="$tmp/overcenter-exec"
root="$tmp/task-root"
outside="$tmp/outside"
manifest="$tmp/task.manifest"
worker="$root/hostile-worker"

mkdir -p "$root" "$outside"
printf 'SAFE\n' > "$root/allowed.txt"
printf 'SECRET\n' > "$outside/secret.txt"
printf 'UNCHANGED\n' > "$outside/write-target.txt"

printf '%s\n' '== toolchain =='
rustc --version
uname -srmo

printf '%s\n' '== compile production launcher and hostile worker =='
rustc --edition=2021 -D warnings "$here/main.rs" -o "$launcher"
rustc --edition=2021 -D warnings "$here/hostile_worker.rs" -o "$worker"

workspace_dev="$(stat -c %d "$root")"
workspace_ino="$(stat -c %i "$root")"

{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tproof-task\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t%s\n' "$worker"
  printf 'arg\t%s\n' "$outside/secret.txt"
  printf 'arg\t%s\n' "$outside/write-target.txt"
  printf 'env\tOVERCENTER_TEST\texplicit\n'
  if [[ -f /etc/ld.so.cache ]]; then
    printf 'runtime_ro\t/etc/ld.so.cache\n'
  fi
  while IFS= read -r dependency; do
    printf 'runtime_exec\t%s\n' "$dependency"
  done < <(ldd "$worker" 2>/dev/null | grep -oE '/[^[:space:]]+' | sed 's/[()]$//' | sort -u || true)
} > "$manifest"

printf '%s\n' '== launcher rejects argv manifest injection =='
if "$launcher" "$manifest" >"$tmp/argv.out" 2>"$tmp/argv.err"; then
  echo 'launcher unexpectedly accepted a manifest pathname' >&2
  exit 1
fi
grep -q 'usage: overcenter-exec < execution-manifest' "$tmp/argv.err"

printf '%s\n' '== stale workspace identity fails before sandbox entry =='
swap_root="$tmp/swap-root"
mkdir -p "$swap_root"
swap_dev="$(stat -c %d "$swap_root")"
swap_ino="$(stat -c %i "$swap_root")"
stale_manifest="$tmp/stale.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tstale-root\n'
  printf 'workspace\t%s\n' "$swap_root"
  printf 'workspace_dev\t%s\n' "$swap_dev"
  printf 'workspace_ino\t%s\n' "$swap_ino"
  printf 'program\t/bin/true\n'
} > "$stale_manifest"
mv "$swap_root" "$tmp/original-swap-root"
mkdir -p "$swap_root"
if "$launcher" < "$stale_manifest" >"$tmp/stale.out" 2>"$tmp/stale.err"; then
  echo 'stale workspace identity unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'workspace identity changed' "$tmp/stale.err"

printf '%s\n' '== ambient authority is physically removed =='
exec 200<"$outside/secret.txt"
GITHUB_TOKEN='AMBIENT-GITHUB-SECRET' \
AWS_SECRET_ACCESS_KEY='AMBIENT-AWS-SECRET' \
  "$launcher" < "$manifest"
exec 200<&-

printf '%s\n' '== verify durable filesystem effects =='
test "$(cat "$root/output.txt")" = 'TASK-WRITE'
test "$(cat "$outside/secret.txt")" = 'SECRET'
test "$(cat "$outside/write-target.txt")" = 'UNCHANGED'

printf '\nPASS: production Rust worker confinement boundary\n'
