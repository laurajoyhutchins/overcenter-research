#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo_root/runtime/overcenter-exec"
tmp="$(mktemp -d)"
cgroup_root=""
cgroup_parent=""
original_cgroup=""
proof_pid="$"

cleanup_resource_leaf() {
  local pid="$1"
  local leaf="$cgroup_parent/overcenter-$pid"
  [[ -d "$leaf" ]] || return 0
  if [[ -w "$leaf/cgroup.kill" ]]; then
    printf '1' > "$leaf/cgroup.kill" 2>/dev/null || true
  fi
  for _ in {1..50}; do
    rmdir "$leaf" 2>/dev/null && return 0
    sleep 0.01
  done
  echo "failed to remove resource cgroup $leaf" >&2
  return 1
}

cleanup() {
  set +e
  if [[ -n "$cgroup_root" && -d "$cgroup_root" ]]; then
    if [[ -n "$original_cgroup" ]]; then
      printf '%s' "$proof_pid" | sudo tee "/sys/fs/cgroup${original_cgroup}/cgroup.procs" >/dev/null
    fi
    for leaf in "$cgroup_parent"/overcenter-*; do
      [[ -d "$leaf" ]] || continue
      printf '1' | sudo tee "$leaf/cgroup.kill" >/dev/null 2>&1 || true
      sudo rmdir "$leaf" 2>/dev/null || true
    done
    sudo rmdir "$cgroup_root/host" "$cgroup_root/work" "$cgroup_root" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

setup_cgroup_delegation() {
  test -f /sys/fs/cgroup/cgroup.controllers
  command -v sudo >/dev/null
  original_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
  test -n "$original_cgroup"

  for controller in cpu memory pids; do
    grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers
  done

  cgroup_root="/sys/fs/cgroup/overcenter-proof-$proof_pid"
  cgroup_parent="$cgroup_root/work"
  sudo mkdir "$cgroup_root"
  printf '+cpu +memory +pids' | sudo tee "$cgroup_root/cgroup.subtree_control" >/dev/null
  sudo mkdir "$cgroup_root/host" "$cgroup_parent"
  printf '+cpu +memory +pids' | sudo tee "$cgroup_parent/cgroup.subtree_control" >/dev/null

  sudo chown "$UID:$(id -g)" \
    "$cgroup_root" "$cgroup_root/cgroup.procs" "$cgroup_root/cgroup.subtree_control" \
    "$cgroup_root/host" "$cgroup_root/host/cgroup.procs" \
    "$cgroup_parent" "$cgroup_parent/cgroup.procs" "$cgroup_parent/cgroup.subtree_control"

  printf '%s' "$proof_pid" | sudo tee "$cgroup_root/host/cgroup.procs" >/dev/null
}

launcher="$tmp/overcenter-exec"
root="$tmp/task-root"
outside="$tmp/outside"
manifest="$tmp/task.manifest"
worker="$root/hostile-worker"
x32_probe="$root/x32-probe"
resource_probe="$root/resource-probe"

mkdir -p "$root" "$outside"
printf 'SAFE\n' > "$root/allowed.txt"
printf 'SECRET\n' > "$outside/secret.txt"
printf 'UNCHANGED\n' > "$outside/write-target.txt"
cp /bin/true "$root/undeclared-executable"
chmod 755 "$root/undeclared-executable"

printf '%s\n' '== toolchain =='
rustc --version
uname -srmo

printf '%s\n' '== delegated cgroup v2 parent =='
setup_cgroup_delegation
printf 'parent=%s controllers=%s\n' "$cgroup_parent" "$(cat "$cgroup_parent/cgroup.subtree_control")"

printf '%s\n' '== compile production launcher and hostile worker =='
rustc --edition=2021 -D warnings "$here/main.rs" -o "$launcher"
rustc --edition=2021 -D warnings "$here/hostile_worker.rs" -o "$worker"
rustc --edition=2021 -D warnings "$here/x32_probe.rs" -o "$x32_probe"
rustc --edition=2021 -D warnings "$here/resource_probe.rs" -o "$resource_probe"
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
  printf 'memory_max_bytes\t268435456\n'
  printf 'pids_max\t32\n'
  printf 'cpu_quota_us\t100000\n'
  printf 'cpu_period_us\t100000\n'
}

run_launcher() {
  local task_manifest="$1"
  local task_workspace="$2"
  local status=0
  "$launcher" 3<"$task_workspace" 4<"$cgroup_parent" <"$task_manifest" &
  local pid=$!
  wait "$pid" || status=$?
  cleanup_resource_leaf "$pid"
  return "$status"
}

write_resource_manifest() {
  local target="$1"
  local task="$2"
  local mode="$3"
  local memory="$4"
  local pids="$5"
  local quota="$6"
  local period="$7"
  {
    printf 'OVERCENTER_EXEC_V1\n'
    printf 'task_id\t%s\n' "$task"
    printf 'workspace\t%s\n' "$root"
    printf 'workspace_dev\t%s\n' "$workspace_dev"
    printf 'workspace_ino\t%s\n' "$workspace_ino"
    printf 'program\t%s\n' "$loader"
    printf 'timeout_ms\t60000\n'
    printf 'max_output_bytes\t1048576\n'
    printf 'memory_max_bytes\t%s\n' "$memory"
    printf 'pids_max\t%s\n' "$pids"
    printf 'cpu_quota_us\t%s\n' "$quota"
    printf 'cpu_period_us\t%s\n' "$period"
    printf 'arg\t%s\n' "$resource_probe"
    printf 'arg\t%s\n' "$mode"
    runtime_closure "$resource_probe"
  } > "$target"
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
"$launcher" 3<&201 4<"$cgroup_parent" < "$pinned_manifest" &
pinned_pid=$!
wait "$pinned_pid"
cleanup_resource_leaf "$pinned_pid"
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

printf '%s\n' '== pids.max stops fork growth for the whole worker cgroup =='
pids_manifest="$tmp/pids.manifest"
write_resource_manifest "$pids_manifest" resource-pids pids 134217728 6 100000 100000
"$launcher" 3<"$root" 4<"$cgroup_parent" <"$pids_manifest" >"$tmp/pids.out" 2>"$tmp/pids.err" &
pids_pid=$!
pids_status=0
wait "$pids_pid" || pids_status=$?
test "$pids_status" -eq 0
grep -q '^PIDS_LIMIT ' "$tmp/pids.out"
pids_leaf="$cgroup_parent/overcenter-$pids_pid"
test "$(awk '$1 == "max" { print $2 }' "$pids_leaf/pids.events")" -ge 1
test "$(cat "$pids_leaf/pids.peak")" -le 6
cleanup_resource_leaf "$pids_pid"

printf '%s\n' '== cpu.max produces observable throttling =='
cpu_manifest="$tmp/cpu.manifest"
write_resource_manifest "$cpu_manifest" resource-cpu cpu 134217728 16 10000 100000
"$launcher" 3<"$root" 4<"$cgroup_parent" <"$cpu_manifest" >"$tmp/cpu.out" 2>"$tmp/cpu.err" &
cpu_pid=$!
cpu_status=0
wait "$cpu_pid" || cpu_status=$?
test "$cpu_status" -eq 0
grep -q '^CPU_BUSY$' "$tmp/cpu.out"
cpu_leaf="$cgroup_parent/overcenter-$cpu_pid"
test "$(awk '$1 == "nr_throttled" { print $2 }' "$cpu_leaf/cpu.stat")" -ge 1
cleanup_resource_leaf "$cpu_pid"

printf '%s\n' '== memory.max contains OOM to the worker cgroup =='
memory_manifest="$tmp/memory.manifest"
write_resource_manifest "$memory_manifest" resource-memory memory 33554432 16 100000 100000
"$launcher" 3<"$root" 4<"$cgroup_parent" <"$memory_manifest" >"$tmp/memory.out" 2>"$tmp/memory.err" &
memory_pid=$!
memory_status=0
wait "$memory_pid" || memory_status=$?
test "$memory_status" -ne 0
memory_leaf="$cgroup_parent/overcenter-$memory_pid"
test "$(awk '$1 == "oom_kill" { print $2 }' "$memory_leaf/memory.events")" -ge 1
test "$(cat "$memory_leaf/memory.peak")" -le 50331648
cleanup_resource_leaf "$memory_pid"

printf '%s\n' '== ambient authority is physically removed =='
exec 200<"$outside/secret.txt"
GITHUB_TOKEN='AMBIENT-GITHUB-SECRET' \
AWS_SECRET_ACCESS_KEY='AMBIENT-AWS-SECRET' \
  "$launcher" 3<"$root" 4<"$cgroup_parent" < "$manifest" &
ambient_pid=$!
wait "$ambient_pid"
cleanup_resource_leaf "$ambient_pid"
exec 200<&-

printf '%s\n' '== verify durable filesystem effects =='
test "$(cat "$root/output.txt")" = 'TASK-WRITE'
test "$(cat "$outside/secret.txt")" = 'SECRET'
test "$(cat "$outside/write-target.txt")" = 'UNCHANGED'

printf '\nPASS: production Rust worker confinement boundary\n'
