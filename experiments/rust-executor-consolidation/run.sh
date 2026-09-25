#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

tmp="$(mktemp -d)"
proof_pid="$BASHPID"
cgroup_root=""
cgroup_parent=""
go_bench=""
rust_bench=""
original_cgroup=""
report="${OVERCENTER_RUST_CONSOLIDATION_REPORT:-$tmp/result.json}"

cleanup() {
  set +e
  if [[ -n "$cgroup_root" && -d "$cgroup_root" ]]; then
    if [[ -n "$original_cgroup" ]]; then
      printf '%s' "$proof_pid" | sudo tee "/sys/fs/cgroup${original_cgroup}/cgroup.procs" >/dev/null 2>&1 || true
    fi
    printf '1' | sudo tee "$cgroup_root/cgroup.kill" >/dev/null 2>&1 || true
    for parent in "$cgroup_parent" "$rust_bench"; do
      [[ -n "$parent" && -d "$parent" ]] || continue
      for leaf in "$parent"/overcenter-*; do
        [[ -d "$leaf" ]] || continue
        sudo rmdir "$leaf" 2>/dev/null || true
      done
    done
    sudo rmdir "$cgroup_parent" "$rust_bench" "$go_bench" "$cgroup_root/host" "$cgroup_root" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

go_version="$(tr -d '\r\n' < .go-version)"
test "$(go env GOVERSION)" = "go${go_version}"
rust_version="$(sed -n 's/^channel = "\([^"]*\)"$/\1/p' rust-toolchain.toml)"
test -n "$rust_version"
test "$(rustc --version | awk '{print $2}')" = "$rust_version"

rust_treatment="$tmp/rust-treatment"
mkdir "$rust_treatment"
cp src/execution/confinement/main.rs "$rust_treatment/main.rs"
cp src/execution/confinement/resource.rs "$rust_treatment/resource.rs"
cp experiments/rust-executor-consolidation/treatment/manifest.rs "$rust_treatment/manifest.rs"
cp experiments/rust-executor-consolidation/treatment/sandbox.rs "$rust_treatment/sandbox.rs"
rustc --edition=2021 -D warnings "$rust_treatment/main.rs" -o "$tmp/overcenter-exec"
rustc --edition=2021 -D warnings experiments/rust-executor-consolidation/descendant.rs -o "$tmp/descendant-fixture"
sudo chown root:root "$tmp/descendant-fixture"
sudo chmod 755 "$tmp/descendant-fixture"
(
  cd src/execution/executor
  go test ./...
  CGO_ENABLED=0 go build -trimpath -buildvcs=false -o "$tmp/overcenter-executor" ./cmd/overcenter-executor
)

test -f /sys/fs/cgroup/cgroup.controllers
command -v sudo >/dev/null
original_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
test -n "$original_cgroup"
for controller in cpu memory pids; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers
done

cgroup_root="/sys/fs/cgroup/overcenter-rust-consolidation-$proof_pid"
cgroup_parent="$cgroup_root/work"
go_bench="$cgroup_root/go-bench"
rust_bench="$cgroup_root/rust-bench"
sudo mkdir "$cgroup_root"
printf '+cpu +memory +pids' | sudo tee "$cgroup_root/cgroup.subtree_control" >/dev/null
sudo mkdir "$cgroup_root/host" "$cgroup_parent" "$go_bench" "$rust_bench"

for dir in "$cgroup_parent" "$go_bench" "$rust_bench"; do
  printf '2147483648' | sudo tee "$dir/memory.max" >/dev/null
  printf '4096' | sudo tee "$dir/pids.max" >/dev/null
  printf '400000 100000' | sudo tee "$dir/cpu.max" >/dev/null
  printf '0' | sudo tee "$dir/cpu.max.burst" >/dev/null
done
for dir in "$cgroup_parent" "$rust_bench"; do
  printf '256' | sudo tee "$dir/cgroup.max.descendants" >/dev/null
  printf '1' | sudo tee "$dir/cgroup.max.depth" >/dev/null
  printf '+cpu +memory +pids' | sudo tee "$dir/cgroup.subtree_control" >/dev/null
done

sudo chown "$UID:$(id -g)" \
  "$cgroup_root" "$cgroup_root/cgroup.procs" "$cgroup_root/cgroup.subtree_control" \
  "$cgroup_root/host" "$cgroup_root/host/cgroup.procs" \
  "$cgroup_parent" "$cgroup_parent/cgroup.procs" "$cgroup_parent/cgroup.subtree_control" \
  "$go_bench" "$go_bench/cgroup.procs" \
  "$rust_bench" "$rust_bench/cgroup.procs" "$rust_bench/cgroup.subtree_control"
printf '%s' "$proof_pid" | sudo tee "$cgroup_root/host/cgroup.procs" >/dev/null

workspace="$tmp/workspace"
mkdir "$workspace"

semantic_report="$tmp/semantic.json"
node --experimental-strip-types experiments/rust-executor-consolidation/comparison.ts \
  "--go=$tmp/overcenter-executor" \
  "--rust=$tmp/overcenter-exec" \
  "--cgroup=$cgroup_parent" \
  "--workspace=$workspace" \
  "--descendant=$tmp/descendant-fixture" | tee "$semantic_report"

node --experimental-strip-types experiments/rust-executor-consolidation/fabric-comparison.ts \
  "--go=$tmp/overcenter-executor" \
  "--rust=$tmp/overcenter-exec" \
  "--go-cgroup=$go_bench" \
  "--rust-cgroup=$rust_bench" \
  "--workspace=$workspace" \
  "--semantic-report=$semantic_report" | tee "$report"
