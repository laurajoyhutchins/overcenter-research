#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_file="$repo_root/native/worker-client/main.rs"
output="${1:-$repo_root/.overcenter-build/overcenter}"

mkdir -p "$(dirname "$output")"
rustc \
  --edition=2021 \
  -D warnings \
  -C opt-level=2 \
  -C strip=symbols \
  -C target-feature=+crt-static \
  "$source_file" \
  -o "$output"

chmod 755 "$output"

if command -v readelf >/dev/null; then
  if readelf -l "$output" | grep -q "INTERP"; then
    echo "portable worker client unexpectedly requires a dynamic loader" >&2
    exit 1
  fi
fi

printf "%s\n" "$output"
