#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: $0 COMMAND [ARG ...]" >&2
  exit 64
fi

test -f /sys/fs/cgroup/cgroup.controllers
command -v sudo >/dev/null

for controller in cpu memory pids; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers
done

supervisor_pid="$BASHPID"
original_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
test -n "$original_cgroup"

root="/sys/fs/cgroup/overcenter-sandbox-$supervisor_pid"
host="$root/host"
parent="$root/work"

cleanup() {
  set +e
  if [[ -d "$root" ]]; then
    printf '%s' "$supervisor_pid" | sudo tee "/sys/fs/cgroup${original_cgroup}/cgroup.procs" >/dev/null 2>&1 || true
    if [[ -d "$parent" ]]; then
      for leaf in "$parent"/overcenter-*; do
        [[ -d "$leaf" ]] || continue
        printf '1' | sudo tee "$leaf/cgroup.kill" >/dev/null 2>&1 || true
        sudo rmdir "$leaf" 2>/dev/null || true
      done
    fi
    sudo rmdir "$host" "$parent" "$root" 2>/dev/null || true
  fi
}
trap cleanup EXIT

sudo mkdir "$root"
printf '+cpu +memory +pids' | sudo tee "$root/cgroup.subtree_control" >/dev/null
sudo mkdir "$host" "$parent"

printf '1073741824' | sudo tee "$parent/memory.max" >/dev/null
printf '256' | sudo tee "$parent/pids.max" >/dev/null
printf '64' | sudo tee "$parent/cgroup.max.descendants" >/dev/null
printf '1' | sudo tee "$parent/cgroup.max.depth" >/dev/null
printf '400000 100000' | sudo tee "$parent/cpu.max" >/dev/null
printf '0' | sudo tee "$parent/cpu.max.burst" >/dev/null
printf '+cpu +memory +pids' | sudo tee "$parent/cgroup.subtree_control" >/dev/null

sudo chown "$UID:$(id -g)"   "$root" "$root/cgroup.procs" "$root/cgroup.subtree_control"   "$host" "$host/cgroup.procs"   "$parent" "$parent/cgroup.procs" "$parent/cgroup.subtree_control"

printf '%s' "$supervisor_pid" | sudo tee "$host/cgroup.procs" >/dev/null

test "$(cat "$parent/memory.max")" = '1073741824'
test "$(cat "$parent/pids.max")" = '256'
test "$(cat "$parent/cgroup.max.descendants")" = '64'
test "$(cat "$parent/cgroup.max.depth")" = '1'
test "$(cat "$parent/cpu.max")" = '400000 100000'
test "$(cat "$parent/cpu.max.burst")" = '0'

OVERCENTER_CGROUP_PARENT="$parent" "$@"
