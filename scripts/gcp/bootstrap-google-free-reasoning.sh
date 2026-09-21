#!/usr/bin/env bash
set -euo pipefail

IDENTITY_PROJECT_ID="project-6b810532-a302-48dc-b56"
IDENTITY_PROJECT_NUMBER="380435294892"
POOL_ID="github-reasoning"
PROVIDER_ID="overcenter-research"
READER_SA_NAME="oc-reasoning-key-reader"
REPOSITORY="laurajoyhutchins/overcenter-research"
GEMINI_KEY_ID="overcenter-google-free"
GEMINI_SA_NAME="overcenter-gemini-inference"
READER_ROLE_ID="overcenterFreeInferenceReader"

for account_id in "$READER_SA_NAME" "$GEMINI_SA_NAME"; do
  [[ "$account_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || {
    echo "Invalid GCP service-account ID: $account_id" >&2
    exit 2
  }
done

for command in gcloud gh jq curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 2; }
done

retry_read() {
  local attempts="$1"
  shift
  local output=""
  for _ in $(seq 1 "$attempts"); do
    if output="$("$@" 2>/dev/null)"; then
      printf '%s' "$output"
      return 0
    fi
    sleep 2
  done
  "$@"
}
gh auth status --hostname github.com >/dev/null 2>&1 || { echo "gh must be authenticated" >&2; exit 2; }
[[ -n "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)" ]] || {
  echo "gcloud must have an active administrator identity" >&2
  exit 2
}

REPO_JSON="$(gh api "repos/$REPOSITORY" --jq '{repository_id:.id,owner_id:.owner.id,full_name:.full_name}')"
REPOSITORY_ID="$(jq -r '.repository_id' <<<"$REPO_JSON")"
OWNER_ID="$(jq -r '.owner_id' <<<"$REPO_JSON")"
[[ "$REPOSITORY_ID" =~ ^[0-9]+$ && "$OWNER_ID" =~ ^[0-9]+$ ]] || {
  echo "Could not resolve immutable GitHub repository identity" >&2
  exit 2
}
test "$(jq -r '.full_name' <<<"$REPO_JSON")" = "$REPOSITORY"

resolve_free_project() {
  if [[ -n "${GEMINI_FREE_PROJECT_ID:-}" ]]; then
    printf '%s\n' "$GEMINI_FREE_PROJECT_ID"
    return
  fi

  local -a candidates=()
  while IFS= read -r project; do
    [[ -n "$project" && "$project" != "$IDENTITY_PROJECT_ID" ]] || continue
    local billing
    billing="$(gcloud beta billing projects describe "$project" --format='value(billingEnabled)' 2>/dev/null || true)"
    [[ "${billing,,}" == "false" ]] || continue
    local enabled
    enabled="$(gcloud services list --enabled --project="$project"       --filter='config.name=generativelanguage.googleapis.com'       --format='value(config.name)' 2>/dev/null || true)"
    [[ "$enabled" == "generativelanguage.googleapis.com" ]] || continue
    candidates+=("$project")
  done < <(gcloud projects list --format='value(projectId)')

  if [[ "${#candidates[@]}" -eq 1 ]]; then
    printf '%s\n' "${candidates[0]}"
    return
  fi

  if [[ "${#candidates[@]}" -gt 1 ]]; then
    printf 'Found multiple billing-disabled projects with Generative Language API enabled:\n' >&2
    printf '  %s\n' "${candidates[@]}" >&2
    echo "Set GEMINI_FREE_PROJECT_ID explicitly and rerun." >&2
    exit 2
  fi

  local project="oc-gemini-free-${REPOSITORY_ID}"
  if ! gcloud projects describe "$project" >/dev/null 2>&1; then
    echo "No existing free Gemini project found; creating $project" >&2
    gcloud projects create "$project" \
      --name="Overcenter Gemini Free" \
      --no-set-as-default >/dev/null
  fi

  local billing_json
  billing_json="$(gcloud beta billing projects describe "$project" --format=json)"
  jq -e '.billingEnabled == false' <<<"$billing_json" >/dev/null || {
    echo "Automatically created Gemini project unexpectedly has billing enabled: $project" >&2
    exit 1
  }

  printf '%s\n' "$project"
}

GEMINI_PROJECT_ID="$(resolve_free_project)"
BILLING_JSON="$(gcloud beta billing projects describe "$GEMINI_PROJECT_ID" --format=json)"
jq -e '.billingEnabled == false' <<<"$BILLING_JSON" >/dev/null || {
  echo "GEMINI_FREE_PROJECT_ID must have Cloud Billing disabled" >&2
  exit 2
}
GEMINI_PROJECT_NUMBER="$(gcloud projects describe "$GEMINI_PROJECT_ID" --format='value(projectNumber)')"
[[ "$GEMINI_PROJECT_NUMBER" =~ ^[0-9]+$ ]] || { echo "Could not resolve Gemini project number" >&2; exit 2; }

gcloud services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudbilling.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="$IDENTITY_PROJECT_ID" >/dev/null

if ! gcloud iam workload-identity-pools describe "$POOL_ID"     --project="$IDENTITY_PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID"     --project="$IDENTITY_PROJECT_ID"     --location=global     --display-name="GitHub reasoning workers"
fi

ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id"
ATTRIBUTE_CONDITION="assertion.repository_id == '$REPOSITORY_ID' && assertion.repository_owner_id == '$OWNER_ID'"

if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID"     --project="$IDENTITY_PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID"     --project="$IDENTITY_PROJECT_ID"     --location=global     --workload-identity-pool="$POOL_ID"     --issuer-uri="https://token.actions.githubusercontent.com/"     --attribute-mapping="$ATTRIBUTE_MAPPING"     --attribute-condition="$ATTRIBUTE_CONDITION"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID"     --project="$IDENTITY_PROJECT_ID"     --location=global     --workload-identity-pool="$POOL_ID"     --display-name="Overcenter research reasoning"     --issuer-uri="https://token.actions.githubusercontent.com/"     --attribute-mapping="$ATTRIBUTE_MAPPING"     --attribute-condition="$ATTRIBUTE_CONDITION"
fi

WIF_PROVIDER="$(retry_read 15 gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$IDENTITY_PROJECT_ID" \
  --location=global \
  --workload-identity-pool="$POOL_ID" \
  --format='value(name)')"
EXPECTED_PROVIDER="projects/$IDENTITY_PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/providers/$PROVIDER_ID"
test "$WIF_PROVIDER" = "$EXPECTED_PROVIDER"

READER_SA="$READER_SA_NAME@$IDENTITY_PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$READER_SA" --project="$IDENTITY_PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$READER_SA_NAME"     --project="$IDENTITY_PROJECT_ID"     --display-name="Overcenter reasoning API-key reader"
fi

FEDERATED_REPOSITORY="principalSet://iam.googleapis.com/projects/$IDENTITY_PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.repository_id/$REPOSITORY_ID"
gcloud iam service-accounts add-iam-policy-binding "$READER_SA"   --project="$IDENTITY_PROJECT_ID"   --member="$FEDERATED_REPOSITORY"   --role="roles/iam.workloadIdentityUser" >/dev/null

gcloud services enable   apikeys.googleapis.com   generativelanguage.googleapis.com   iam.googleapis.com   --project="$GEMINI_PROJECT_ID" >/dev/null

GEMINI_SA="$GEMINI_SA_NAME@$GEMINI_PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$GEMINI_SA" --project="$GEMINI_PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$GEMINI_SA_NAME"     --project="$GEMINI_PROJECT_ID"     --display-name="Overcenter free Gemini inference"
fi

ROLE_NAME="projects/$GEMINI_PROJECT_ID/roles/$READER_ROLE_ID"
if gcloud iam roles describe "$READER_ROLE_ID" --project="$GEMINI_PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam roles update "$READER_ROLE_ID"     --project="$GEMINI_PROJECT_ID"     --title="Overcenter free inference key reader"     --permissions="apikeys.keys.getKeyString,resourcemanager.projects.get"     --stage=GA >/dev/null
else
  gcloud iam roles create "$READER_ROLE_ID"     --project="$GEMINI_PROJECT_ID"     --title="Overcenter free inference key reader"     --description="Read the one Gemini authorization key and prove project billing state."     --permissions="apikeys.keys.getKeyString,resourcemanager.projects.get"     --stage=GA >/dev/null
fi

gcloud projects add-iam-policy-binding "$GEMINI_PROJECT_ID"   --member="serviceAccount:$READER_SA"   --role="$ROLE_NAME"   --condition=None >/dev/null

KEY_RESOURCE="projects/$GEMINI_PROJECT_NUMBER/locations/global/keys/$GEMINI_KEY_ID"
ACCESS_TOKEN="$(gcloud auth print-access-token)"
KEY_HTTP="$(curl --silent --show-error -o "${TMPDIR:-/tmp}/overcenter-gemini-key.json" -w '%{http_code}'   -H "Authorization: Bearer $ACCESS_TOKEN"   "https://apikeys.googleapis.com/v2/$KEY_RESOURCE")"

if [[ "$KEY_HTTP" == "404" ]]; then
  REQUEST_BODY="$(jq -n     --arg display "Overcenter free Gemini reasoning"     --arg service "generativelanguage.googleapis.com"     --arg service_account "$GEMINI_SA"     '{displayName:$display,restrictions:{apiTargets:[{service:$service}]},serviceAccountEmail:$service_account}')"
  OPERATION="$(curl --fail-with-body --silent --show-error -X POST     -H "Authorization: Bearer $ACCESS_TOKEN"     -H 'Content-Type: application/json; charset=utf-8'     -d "$REQUEST_BODY"     "https://apikeys.googleapis.com/v2/projects/$GEMINI_PROJECT_NUMBER/locations/global/keys?keyId=$GEMINI_KEY_ID")"
  OPERATION_NAME="$(jq -er '.name' <<<"$OPERATION")"
  for _ in $(seq 1 60); do
    OPERATION="$(curl --fail-with-body --silent --show-error       -H "Authorization: Bearer $ACCESS_TOKEN"       "https://apikeys.googleapis.com/v2/$OPERATION_NAME")"
    if [[ "$(jq -r '.done // false' <<<"$OPERATION")" == "true" ]]; then
      jq -e 'has("error") | not' <<<"$OPERATION" >/dev/null
      break
    fi
    sleep 1
  done
  [[ "$(jq -r '.done // false' <<<"$OPERATION")" == "true" ]] || {
    echo "Timed out waiting for Gemini authorization key creation" >&2
    exit 1
  }
elif [[ "$KEY_HTTP" != "200" ]]; then
  cat "${TMPDIR:-/tmp}/overcenter-gemini-key.json" >&2
  echo "Unexpected API Keys response: HTTP $KEY_HTTP" >&2
  exit 1
fi

KEY_METADATA="$(curl --fail-with-body --silent --show-error   -H "Authorization: Bearer $ACCESS_TOKEN"   "https://apikeys.googleapis.com/v2/$KEY_RESOURCE")"
jq -e   --arg service_account "$GEMINI_SA"   '.serviceAccountEmail == $service_account
   and (.restrictions.apiTargets | length == 1)
   and .restrictions.apiTargets[0].service == "generativelanguage.googleapis.com"'   <<<"$KEY_METADATA" >/dev/null

gh variable set GEMINI_FREE_PROJECT_ID --repo "$REPOSITORY" --body "$GEMINI_PROJECT_ID"

printf '%s\n'   "Google-free reasoning bootstrap complete"   "Identity project:    $IDENTITY_PROJECT_ID ($IDENTITY_PROJECT_NUMBER)"   "WIF provider:        $WIF_PROVIDER"   "Reader identity:     $READER_SA"   "GitHub repository:   $REPOSITORY ($REPOSITORY_ID)"   "Gemini free project: $GEMINI_PROJECT_ID ($GEMINI_PROJECT_NUMBER)"   "Gemini key resource: $KEY_RESOURCE"   "Billing enabled:     false"
