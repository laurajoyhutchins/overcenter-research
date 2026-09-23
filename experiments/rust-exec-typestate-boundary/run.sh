#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo_root/experiments/rust-exec-typestate-boundary"
baseline_sha="b683a84d55bb29b166652f00fa8b6be5f2aaec2c"
production="$repo_root/src/execution/confinement/sandbox.rs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v rustc >/dev/null
command -v git >/dev/null

expect_compile_failure() {
  local source="$1"
  local pattern="$2"
  local name
  name="$(basename "$source" .rs)"
  if rustc --edition=2021 "$source" -o "$tmp/$name" >"$tmp/$name.out" 2>"$tmp/$name.err"; then
    echo "$name unexpectedly compiled" >&2
    exit 1
  fi
  if ! grep -Eq "$pattern" "$tmp/$name.err"; then
    echo "$name failed, but not for the expected type-system reason" >&2
    cat "$tmp/$name.err" >&2
    exit 1
  fi
}

printf '%s\n' '== compile-fail controls against production sandbox =='
(
  cd "$here"
  expect_compile_failure "$here/negative-forge.rs" 'private'
  expect_compile_failure "$here/negative-reuse.rs" 'use of moved value'
)

printf '%s\n' '== source complexity and runtime-guard census =='
baseline="$tmp/baseline.rs"
git show "$baseline_sha:src/execution/confinement/sandbox.rs" > "$baseline"

sloc() {
  awk 'NF && $1 !~ /^\/\//' "$1" | wc -l
}
baseline_sloc="$(sloc "$baseline")"
treatment_sloc="$(sloc "$production")"

guards=(
  'ensure_unprivileged_caller'
  'resource::enter'
  'pin_workspace'
  'landlock_abi'
  'handled_fs_rights'
  'create_ruleset'
  'add_fd_rule'
  'add_program_rule'
  'add_runtime_rule'
  'fchdir'
  'restrict_self'
  'close_inherited_fds'
  'install_seccomp_policy'
)
guard_count() {
  local file="$1"
  local total=0
  local pattern
  for pattern in "${guards[@]}"; do
    if grep -q "$pattern" "$file"; then
      total=$((total + 1))
    fi
  done
  printf '%s' "$total"
}
baseline_guards="$(guard_count "$baseline")"
treatment_guards="$(guard_count "$production")"

printf 'baseline_sloc=%s treatment_sloc=%s delta=%+d\n'   "$baseline_sloc" "$treatment_sloc" "$((treatment_sloc-baseline_sloc))"
printf 'baseline_runtime_guard_classes=%s treatment_runtime_guard_classes=%s\n'   "$baseline_guards" "$treatment_guards"

if (( treatment_sloc <= baseline_sloc && treatment_guards < baseline_guards )); then
  printf '%s\n' 'hypothesis=SUPPORTED'
else
  printf '%s\n' 'hypothesis=FALSIFIED'
fi

printf '%s\n' 'PASS: experiment executed; hypothesis result is reported above'
