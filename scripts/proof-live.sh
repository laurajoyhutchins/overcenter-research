#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${GH_TOKEN:-}" ]]; then
  echo "proof:live ignores GH_TOKEN; use GITHUB_TOKEN or gh auth login" >&2
  unset GH_TOKEN
fi

REF=""
REPO=""

usage() {
  cat <<'EOF'
usage: scripts/proof-live.sh [--ref <branch-or-tag>] [--repo <owner/repo>]

Dispatch every hosted Overcenter proof, require each run to execute the same
source revision, and wait for every run to succeed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v gh >/dev/null 2>&1 || {
  echo "proof:live requires the GitHub CLI (gh)" >&2
  exit 2
}

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

if [[ -z "$REF" ]]; then
  REF="$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"
fi

EXPECTED_SHA="$(gh api "repos/$REPO/commits/$REF" --jq '.sha')"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "could not resolve exact source revision for $REPO@$REF" >&2
  exit 2
}

WORKFLOWS=(
  disposable-agent-proof.yml
  github-observation-grammar.yml
  github-object-transport-proof.yml
)

echo "Live proof revision: $REPO@$REF = $EXPECTED_SHA"

for workflow in "${WORKFLOWS[@]}"; do
  echo "==> dispatching $workflow"
  output="$(gh workflow run "$workflow" --repo "$REPO" --ref "$REF")"
  run_url="$(printf '%s\n' "$output" | awk 'NF { line=$0 } END { print line }')"

  if [[ ! "$run_url" =~ /actions/runs/([0-9]+)$ ]]; then
    echo "GitHub did not return an attributable workflow run URL for $workflow" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  run_id="${BASH_REMATCH[1]}"
  actual_sha="$(gh run view "$run_id" --repo "$REPO" --json headSha --jq '.headSha')"

  if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
    echo "$workflow ran at $actual_sha, expected $EXPECTED_SHA" >&2
    echo "The requested ref moved or the run could not be bound to the intended revision." >&2
    exit 1
  fi

  gh run watch "$run_id" --repo "$REPO" --exit-status
done

echo "All hosted proofs passed at $EXPECTED_SHA"
