#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fstar="${FSTAR_BIN:-fstar.exe}"

echo "== F* version =="
"$fstar" --version

echo "== Pulse capability concurrency =="
"$fstar" --include "$here" "$here/CapabilityConcurrency.fst"

echo "Pulse capability-concurrency experiment passed."
