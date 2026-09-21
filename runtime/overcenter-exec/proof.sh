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
x32_probe="$root/x32-probe"

mkdir -p "$root" "$outside"
printf 'SAFE\n' > "$root/allowed.txt"
printf 'SECRET\n' > "$outside/secret.txt"
printf 'UNCHANGED\n' > "$outside/write-target.txt"
cp /bin/true "$root/undeclared-executable"
chmod 755 "$root/undeclared-executable"

printf '%s\n' '== toolchain =='
rustc --version
uname -srmo

printf '%s\n' '== compile production launcher and hostile worker =='
rustc --edition=2021 -D warnings "$here/main.rs" -o "$launcher"
rustc --edition=2021 -D warnings "$here/hostile_worker.rs" -o "$worker"
rustc --edition=2021 -D warnings "$here/x32_probe.rs" -o "$x32_probe"
loader="$(ldd "$worker" 2>/dev/null | grep -oE '/[^[:space:]]*ld-linux[^[:space:]]*' | head -n 1)"
test -n "$loader"

runtime_closure() {
  local binary="$1"
  if [[ -f /etc/ld.so.cache ]]; then
    printf 'runtime_ro\t/etc/ld.so.cache\n'
  fi
  while IFS= read -r dependency; do
    printf 'runtime_exec\t%s\n' "$dependency"
  done < <(ldd "$binary" 2>/dev/null | grep -oE '/[^[:space:]]+' | sed 's/[()]$//' | sort -u || true)
}

workspace_dev="$(stat -c %d "$root")"
workspace_ino="$(stat -c %i "$root")"

manifest_limits() {
  printf 'timeout_ms\t60000\n'
  printf 'max_output_bytes\t1048576\n'
}

run_launcher() {
  local task_manifest="$1"
  local task_workspace="$2"
  "$launcher" 3<"$task_workspace" <"$task_manifest"
}

{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tproof-task\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t%s\n' "$loader"
  manifest_limits
  printf 'arg\t%s\n' "$worker"
  printf 'arg\t%s\n' "$outside/secret.txt"
  printf 'arg\t%s\n' "$outside/write-target.txt"
  printf 'env\tOVERCENTER_TEST\texplicit\n'
  runtime_closure "$worker"
} > "$manifest"

printf '%s\n' '== launcher rejects argv manifest injection =='
if "$launcher" "$manifest" >"$tmp/argv.out" 2>"$tmp/argv.err"; then
  echo 'launcher unexpectedly accepted a manifest pathname' >&2
  exit 1
fi
grep -q 'usage: overcenter-exec < execution-manifest' "$tmp/argv.err"

printf '%s\n' '== noncanonical manifest bytes fail closed =='
noncanonical_manifest="$tmp/noncanonical.manifest"
printf 'OVERCENTER_EXEC_V1\ntask_id\tnoncanonical\nworkspace\t%s\nworkspace_dev\t%s\nworkspace_ino\t%s\nprogram\t/bin/true' \
  "$root" "$workspace_dev" "$workspace_ino" > "$noncanonical_manifest"
if run_launcher "$noncanonical_manifest" "$root" >"$tmp/noncanonical.out" 2>"$tmp/noncanonical.err"; then
  echo 'manifest without terminal newline unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'manifest must end with exactly one newline-delimited record stream' "$tmp/noncanonical.err"

printf '%s\n' '== runtime closure cannot widen one path into a directory tree =='
directory_manifest="$tmp/directory-runtime.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tdirectory-runtime\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t/bin/true\n'
  manifest_limits
  printf 'runtime_ro\t/etc\n'
} > "$directory_manifest"
if run_launcher "$directory_manifest" "$root" >"$tmp/directory-runtime.out" 2>"$tmp/directory-runtime.err"; then
  echo 'directory runtime grant unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'execution closure path must name a regular file: /etc' "$tmp/directory-runtime.err"

printf '%s\n' '== execution closure rejects IPC and device-shaped objects =='
fifo_runtime="$tmp/runtime-fifo"
mkfifo "$fifo_runtime"
fifo_runtime_manifest="$tmp/fifo-runtime.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tfifo-runtime\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t/bin/true\n'
  manifest_limits
  printf 'runtime_ro\t%s\n' "$fifo_runtime"
} > "$fifo_runtime_manifest"
if run_launcher "$fifo_runtime_manifest" "$root" >"$tmp/fifo-runtime.out" 2>"$tmp/fifo-runtime.err"; then
  echo 'FIFO runtime object unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'execution closure path must name a regular file' "$tmp/fifo-runtime.err"

printf '%s\n' '== runtime aliases cannot union authority for one inode =='
runtime_alias="$tmp/true-alias"
ln -s /bin/true "$runtime_alias"
alias_manifest="$tmp/runtime-alias.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\truntime-alias\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t/bin/true\n'
  manifest_limits
  printf 'runtime_ro\t/bin/true\n'
  printf 'runtime_exec\t%s\n' "$runtime_alias"
} > "$alias_manifest"
if run_launcher "$alias_manifest" "$root" >"$tmp/runtime-alias.out" 2>"$tmp/runtime-alias.err"; then
  echo 'aliased runtime object unexpectedly unioned access modes' >&2
  exit 1
fi
grep -q 'duplicate runtime object identity' "$tmp/runtime-alias.err"

printf '%s\n' '== runtime closure objects must be immutable to worker credentials =='
owned_runtime="$tmp/worker-owned-runtime"
printf 'mutable host runtime\n' > "$owned_runtime"
owned_runtime_manifest="$tmp/owned-runtime.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\towned-runtime\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t/bin/true\n'
  manifest_limits
  printf 'runtime_ro\t%s\n' "$owned_runtime"
} > "$owned_runtime_manifest"
if run_launcher "$owned_runtime_manifest" "$root" >"$tmp/owned-runtime.out" 2>"$tmp/owned-runtime.err"; then
  echo 'worker-owned runtime object unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'execution closure object is owned by worker uid' "$tmp/owned-runtime.err"

printf '%s\n' '== program identity must be immutable to worker credentials =='
owned_program_manifest="$tmp/owned-program.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\towned-program\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t%s\n' "$worker"
  manifest_limits
} > "$owned_program_manifest"
if run_launcher "$owned_program_manifest" "$root" >"$tmp/owned-program.out" 2>"$tmp/owned-program.err"; then
  echo 'worker-owned program unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'execution closure object is owned by worker uid' "$tmp/owned-program.err"

printf '%s\n' '== pinned workspace fd survives pathname replacement =='
pinned_root="$tmp/pinned-root"
mkdir -p "$pinned_root"
pinned_dev="$(stat -c %d "$pinned_root")"
pinned_ino="$(stat -c %i "$pinned_root")"
pinned_manifest="$tmp/pinned.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tpinned-root\n'
  printf 'workspace\t%s\n' "$pinned_root"
  printf 'workspace_dev\t%s\n' "$pinned_dev"
  printf 'workspace_ino\t%s\n' "$pinned_ino"
  printf 'program\t/bin/true\n'
  manifest_limits
  runtime_closure /bin/true
} > "$pinned_manifest"
exec 201<"$pinned_root"
mv "$pinned_root" "$tmp/pinned-root-original"
mkdir -p "$pinned_root"
"$launcher" 3<&201 < "$pinned_manifest"
exec 201<&-

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
  manifest_limits
} > "$stale_manifest"
mv "$swap_root" "$tmp/original-swap-root"
mkdir -p "$swap_root"
if run_launcher "$stale_manifest" "$swap_root" >"$tmp/stale.out" 2>"$tmp/stale.err"; then
  echo 'stale workspace identity unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'workspace identity changed' "$tmp/stale.err"

printf '%s\n' '== x32 syscall namespace is killed before deny-list matching =='
x32_manifest="$tmp/x32.manifest"
{
  printf 'OVERCENTER_EXEC_V1\n'
  printf 'task_id\tx32-probe\n'
  printf 'workspace\t%s\n' "$root"
  printf 'workspace_dev\t%s\n' "$workspace_dev"
  printf 'workspace_ino\t%s\n' "$workspace_ino"
  printf 'program\t%s\n' "$loader"
  manifest_limits
  printf 'arg\t%s\n' "$x32_probe"
  runtime_closure "$x32_probe"
} > "$x32_manifest"
if run_launcher "$x32_manifest" "$root" >"$tmp/x32.out" 2>"$tmp/x32.err"; then
  echo 'x32 syscall namespace unexpectedly escaped seccomp' >&2
  exit 1
else
  x32_status=$?
fi
expected_x32_status=$((128 + $(kill -l SIGSYS)))
if [[ "$x32_status" -ne "$expected_x32_status" ]]; then
  echo "x32 probe exited $x32_status instead of SIGSYS ($expected_x32_status)" >&2
  cat "$tmp/x32.err" >&2
  exit 1
fi

printf '%s\n' '== ambient authority is physically removed =='
exec 200<"$outside/secret.txt"
GITHUB_TOKEN='AMBIENT-GITHUB-SECRET' \
AWS_SECRET_ACCESS_KEY='AMBIENT-AWS-SECRET' \
  "$launcher" 3<"$root" < "$manifest"
exec 200<&-

printf '%s\n' '== verify durable filesystem effects =='
test "$(cat "$root/output.txt")" = 'TASK-WRITE'
test "$(cat "$outside/secret.txt")" = 'SECRET'
test "$(cat "$outside/write-target.txt")" = 'UNCHANGED'

printf '\nPASS: production Rust worker confinement boundary\n'
