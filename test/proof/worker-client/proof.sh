#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

client="$tmp/overcenter"
"$repo_root/src/execution/worker-client/build.sh" "$client" >/dev/null
node --experimental-strip-types "$repo_root/test/proof/worker-client/proof.ts" "$client"

printf '\nPASS: native portable Overcenter worker client\n'
