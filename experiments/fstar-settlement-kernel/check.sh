#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fstar="${FSTAR_BIN:-fstar.exe}"
include=(--include "$here")

echo "== F* version =="
"$fstar" --version

echo "== positive kernel =="
"$fstar" "${include[@]}" --cache_checked_modules "$here/SettlementKernel.fst"
"$fstar" "${include[@]}" --cache_checked_modules "$here/Positive.fst"

echo "== hostile negative controls =="
for source in \
  "$here/Hostile/WrongObligation.fst" \
  "$here/Hostile/StaleRevision.fst" \
  "$here/Hostile/StaleAuthority.fst" \
  "$here/Hostile/ChangedSemantics.fst"
do
  "$fstar" "${include[@]}" "$source"
done

echo "== extraction =="
out="$here/out"
rm -rf "$out"
mkdir -p "$out"
"$fstar" "${include[@]}" \
  --codegen OCaml \
  --extract SettlementKernel \
  --odir "$out" \
  "$here/SettlementKernel.fst"

test -f "$out/SettlementKernel.ml"

echo "F* settlement experiment passed."
