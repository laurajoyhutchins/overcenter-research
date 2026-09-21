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

root="/sys/fs/cgroup/overcenter-sandbox-$BASHPID"
parent="$root/work"

cleanup() {
  set +e
  if [[ -d "$parent" ]]; then
    for leaf in "$parent"/overcenter-*; do
      [[ -d "$leaf" ]] || continue
      if [[ -w "$leaf/cgroup.kill" ]]; then
        printf '1' | sudo tee "$leaf/cgroup.kill" >/dev/null 2>&1 || true
      fi
      sudo rmdir "$leaf" 2>/dev/null || true
    done
  fi
  sudo rmdir "$parent" "$root" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sudo mkdir "$root"
printf '+cpu +memory +pids' | sudo tee "$root/cgroup.subtree_control" >/dev/null
sudo mkdir "$parent"

printf '1073741824' | sudo tee "$parent/memory.max" >/dev/null
printf '256' | sudo tee "$parent/pids.max" >/dev/null
printf '64' | sudo tee "$parent/cgroup.max.descendants" >/dev/null
printf '1' | sudo tee "$parent/cgroup.max.depth" >/dev/null
printf '400000 100000' | sudo tee "$parent/cpu.max" >/dev/null
printf '0' | sudo tee "$parent/cpu.max.burst" >/dev/null
printf '+cpu +memory +pids' | sudo tee "$parent/cgroup.subtree_control" >/dev/null

sudo chown "$UID:$(id -g)"   "$parent"   "$parent/cgroup.procs"   "$parent/cgroup.subtree_control"

test "$(cat "$parent/memory.max")" = '1073741824'
test "$(cat "$parent/pids.max")" = '256'
test "$(cat "$parent/cgroup.max.descendants")" = '64'
test "$(cat "$parent/cgroup.max.depth")" = '1'
test "$(cat "$parent/cpu.max")" = '400000 100000'
test "$(cat "$parent/cpu.max.burst")" = '0'

OVERCENTER_CGROUP_PARENT="$parent" "$@"
