#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fstar="${FSTAR_BIN:-fstar.exe}"

echo "== F* version =="
"$fstar" --version

echo "== positive Pulse capability concurrency =="
"$fstar" --include "$here" "$here/CapabilityConcurrency.fst"

echo "== hostile same-coordinate alias =="
hostile_log="$here/hostile.log"
rm -f "$hostile_log"

set +e
"$fstar" --include "$here" "$here/HostileAlias.fst" >"$hostile_log" 2>&1
status=$?
set -e

cat "$hostile_log"

if (( status == 0 )); then
  echo "hostile alias unexpectedly verified" >&2
  exit 1
fi

echo "Pulse capability-concurrency experiment passed."
