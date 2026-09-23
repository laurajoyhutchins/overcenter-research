#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

command -v rustc >/dev/null

printf '%s\n' '== toolchain =='
rustc --version
uname -srmo

printf '%s\n' '== positive security differential + performance =='
rustc --edition=2021 -O -D warnings "$here/experiment.rs" -o "$tmp/typed-capability-authority"
"$tmp/typed-capability-authority"

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

printf '%s\n' '== compile-fail authority controls =='
expect_compile_failure "$here/negative-forge.rs" 'private'
expect_compile_failure "$here/negative-raw.rs" 'mismatched types'
expect_compile_failure "$here/negative-reuse.rs" 'use of moved value'

printf '\nPASS: typed capability authority experiment\n'
