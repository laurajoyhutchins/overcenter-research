#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$repo_root/experiments/effect-authority-decay"
baseline_sha="81b350e526824ab2c397642e6761a0c860151331"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '%s\n' '== runtime adversarial controls =='
node --experimental-strip-types --test "$here/contract.test.ts"

printf '%s\n' '== authority-decay census =='
files=(
  src/authority/engine.ts
  src/providers/github/status-effect.ts
  src/providers/github/pr-update-branch-effect.ts
)
providers=(
  src/providers/github/status-effect.ts
  src/providers/github/pr-update-branch-effect.ts
)
for file in "${files[@]}"; do
  mkdir -p "$tmp/baseline/$(dirname "$file")"
  git -C "$repo_root" show "$baseline_sha:$file" > "$tmp/baseline/$file"
done

sloc_files() {
  local total=0
  local file
  for file in "$@"; do
    local n
    n="$(awk 'NF && $1 !~ /^\/\//' "$file" | wc -l)"
    total=$((total+n))
  done
  printf '%s' "$total"
}
count_literal() {
  local root="$1"
  local literal="$2"
  shift 2
  local total=0
  local file
  for file in "$@"; do
    local n
    n="$(grep -Foc "$literal" "$root/$file" || true)"
    total=$((total+n))
  done
  printf '%s' "$total"
}

baseline_paths=()
treatment_paths=()
for file in "${files[@]}"; do
  baseline_paths+=("$tmp/baseline/$file")
  treatment_paths+=("$repo_root/$file")
done
baseline_sloc="$(sloc_files "${baseline_paths[@]}")"
treatment_sloc="$(sloc_files "${treatment_paths[@]}")"

baseline_claimed_work="$(count_literal "$tmp/baseline" 'claimedWork(permit.id)' "${providers[@]}")"
treatment_claimed_work="$(count_literal "$repo_root" 'claimedWork(permit.id)' "${providers[@]}")"
baseline_raw_coordinates=0
treatment_raw_coordinates=0
for literal in   'work.id!==permit.obligation_id'   'work.run_id!==permit.id'   'work.claimed_revision!==permit.claimed_revision'
do
  baseline_raw_coordinates=$((baseline_raw_coordinates+$(count_literal "$tmp/baseline" "$literal" "${providers[@]}")))
  treatment_raw_coordinates=$((treatment_raw_coordinates+$(count_literal "$repo_root" "$literal" "${providers[@]}")))
done
baseline_contract_sites="$(count_literal "$tmp/baseline" 'work.packet.effect_contract!==' "${providers[@]}")"
treatment_contract_sites="$(count_literal "$repo_root" 'work.packet.effect_contract!==' "${providers[@]}")"
baseline_verifier_sites="$(count_literal "$tmp/baseline" 'work.postcondition.verifier!==' "${providers[@]}")"
treatment_verifier_sites="$(count_literal "$repo_root" 'work.postcondition.verifier!==' "${providers[@]}")"
baseline_raw_effect_calls="$(count_literal "$tmp/baseline" 'performEffect(permit' "${providers[@]}")"
treatment_raw_effect_calls="$(count_literal "$repo_root" 'performEffect(permit' "${providers[@]}")"
central_mints="$(grep -Fc 'authorizeEffect<' "$repo_root/src/authority/engine.ts" || true)"

printf 'sloc baseline=%s treatment=%s delta=%+d (historical metric; not a maintenance gate)\n'   "$baseline_sloc" "$treatment_sloc" "$((treatment_sloc-baseline_sloc))"
printf 'provider_claimedWork_calls baseline=%s treatment=%s\n'   "$baseline_claimed_work" "$treatment_claimed_work"
printf 'provider_raw_coordinate_comparisons baseline=%s treatment=%s\n'   "$baseline_raw_coordinates" "$treatment_raw_coordinates"
printf 'provider_effect_contract_checks baseline=%s treatment=%s\n'   "$baseline_contract_sites" "$treatment_contract_sites"
printf 'provider_verifier_checks baseline=%s treatment=%s\n'   "$baseline_verifier_sites" "$treatment_verifier_sites"
printf 'provider_raw_performEffect_calls baseline=%s treatment=%s\n'   "$baseline_raw_effect_calls" "$treatment_raw_effect_calls"
printf 'central_authority_mints=%s\n' "$central_mints"

test "$baseline_claimed_work" -gt 0
test "$treatment_claimed_work" -eq 0
test "$baseline_raw_coordinates" -gt 0
test "$treatment_raw_coordinates" -eq 0
test "$baseline_contract_sites" -gt 0
test "$treatment_contract_sites" -eq 0
test "$baseline_verifier_sites" -gt 0
test "$treatment_verifier_sites" -eq 0
test "$baseline_raw_effect_calls" -gt 0
test "$treatment_raw_effect_calls" -eq 0
test "$central_mints" -eq 1

printf '%s\n' 'PASS: maintained authority-decay safety criteria'
