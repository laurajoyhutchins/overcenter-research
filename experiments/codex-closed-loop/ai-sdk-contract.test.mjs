import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const workflow=readFileSync(new URL('../../.github/workflows/autonomy-sandbox-google-free.yml',import.meta.url),'utf8');
const bootstrapUrl=new URL('../../scripts/gcp/bootstrap-google-free-reasoning.sh',import.meta.url);
const bootstrap=readFileSync(bootstrapUrl,'utf8');
const candidate=readFileSync(new URL('./ai-sdk-candidate.ts',import.meta.url),'utf8');
const resolver=readFileSync(new URL('../../src/reasoning-model.ts',import.meta.url),'utf8');
const schema=JSON.parse(readFileSync(new URL('./local-model-candidate.schema.json',import.meta.url),'utf8'));

test('AI SDK routing keeps Gateway default and Google-free as the only direct escape hatch',()=>{
  assert.match(resolver,/default:[\s\S]*transport:'ai-gateway'[\s\S]*model_id:'google\/gemini-3\.8-flash'/);
  assert.match(resolver,/'google-free':[\s\S]*transport:'google-generative-ai'[\s\S]*model_id:'gemini-3\.8-flash'/);
  assert.match(resolver,/GOOGLE_GENERATIVE_AI_API_KEY_REQUIRED/);
  assert.match(resolver,/import\('@ai-sdk\/google'\)/);
  assert.doesNotMatch(resolver,/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test('Google-free bootstrap is valid shell',()=>{
  const result=spawnSync('bash',['-n',fileURLToPath(bootstrapUrl)],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('Google-free proof can run on the exact same-repository PR head',()=>{
  assert.match(workflow,/pull_request:[\s\S]*autonomy-sandbox-google-free\.yml/);
  assert.doesNotMatch(workflow,/pull_request_target/);
  assert.match(workflow,/SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow,/if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
});

test('reasoning identity reuses proven GCP coordinates without reusing production deployment authority',()=>{
  assert.match(workflow,/GCP_IDENTITY_PROJECT_ID: project-6b810532-a302-48dc-b56/);
  assert.match(workflow,/projects\/380435294892\/locations\/global\/workloadIdentityPools\/github-reasoning\/providers\/overcenter-research/);
  assert.match(workflow,/oc-reasoning-key-reader@project-6b810532-a302-48dc-b56\.iam\.gserviceaccount\.com/);
  assert.doesNotMatch(workflow,/overcenter-deployer@/);
  assert.match(bootstrap,/retry_read\(\)/);
  assert.match(bootstrap,/retry_read 15 gcloud iam workload-identity-pools providers describe/);
  assert.match(bootstrap,/POOL_ID="github-reasoning"/);
  assert.match(bootstrap,/PROVIDER_ID="overcenter-research"/);
  assert.match(bootstrap,/READER_SA_NAME="oc-reasoning-key-reader"/);
  assert.match(bootstrap,/Invalid GCP service-account ID/);
  assert.match(bootstrap,/attribute\.repository_id=assertion\.repository_id/);
  assert.match(bootstrap,/attribute\.repository_owner_id=assertion\.repository_owner_id/);
  assert.match(bootstrap,/attribute\.workflow_ref=assertion\.workflow_ref/);
  assert.match(bootstrap,/attribute\.workflow_ref\.startsWith\('\$REPOSITORY\/\.github\/workflows\/autonomy-sandbox-google-free\.yml@'\)/);
});

test('Google-free bootstrap discovers or accepts one unbilled Gemini project and creates one stable auth key',()=>{
  assert.match(bootstrap,/gcloud beta billing projects describe/);
  assert.match(bootstrap,/billingEnabled/);
  assert.match(bootstrap,/generativelanguage\.googleapis\.com/);
  assert.match(bootstrap,/local project="oc-gemini-free-\$\{REPOSITORY_ID\}"/);
  assert.match(bootstrap,/gcloud projects create "\\$project"/);
  assert.match(bootstrap,/--no-set-as-default/);
  assert.match(bootstrap,/Automatically created Gemini project unexpectedly has billing enabled/);
  assert.match(bootstrap,/GEMINI_KEY_ID="overcenter-google-free"/);
  assert.match(bootstrap,/serviceAccountEmail/);
  assert.match(bootstrap,/keyId=\$GEMINI_KEY_ID/);
  assert.match(bootstrap,/apikeys\.keys\.getKeyString,resourcemanager\.projects\.get/);
  assert.match(bootstrap,/gh variable set GEMINI_FREE_PROJECT_ID/);
  assert.doesNotMatch(bootstrap,/keyString.*gh variable|gh secret set/);
});

test('Google-free credential is resolved from Google through GitHub OIDC, not stored in GitHub secrets',()=>{
  assert.match(workflow,/id-token: write/);
  assert.match(workflow,/google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.match(workflow,/workload_identity_provider: \$\{\{ env\.GCP_WORKLOAD_IDENTITY_PROVIDER \}\}/);
  assert.match(workflow,/service_account: \$\{\{ env\.GCP_API_KEY_READER_SERVICE_ACCOUNT \}\}/);
  assert.match(workflow,/token_format: access_token/);
  assert.match(workflow,/access_token_lifetime: 300s/);
  assert.match(workflow,/create_credentials_file: false/);
  assert.match(workflow,/apikeys\.googleapis\.com\/v2\/\$GEMINI_API_KEY_RESOURCE\/keyString/);
  assert.match(workflow,/GEMINI_FREE_PROJECT_ID: \$\{\{ vars\.GEMINI_FREE_PROJECT_ID \}\}/);
  assert.doesNotMatch(workflow,/\$\{\{\s*secrets\./);
  assert.match(candidate,/AI_SDK_GOOGLE_FREE_CREDENTIAL_SOURCE_INVALID/);
  assert.match(candidate,/credential_source:credentialSource/);
});

test('Google-free status is re-proved from Cloud Billing at the inference run',()=>{
  assert.match(workflow,/cloudbilling\.googleapis\.com\/v1\/projects\/\$GEMINI_FREE_PROJECT_ID\/billingInfo/);
  assert.match(workflow,/billing\.billingEnabled!==false/);
  assert.match(workflow,/cloudresourcemanager\.googleapis\.com\/v1\/projects\/\$GEMINI_FREE_PROJECT_ID/);
  assert.match(workflow,/OVERCENTER_REASONING_BILLING_OBSERVATION_SOURCE=google-cloud-billing-api/);
  assert.match(workflow,/OVERCENTER_REASONING_BILLING_ENABLED=false/);
  assert.match(candidate,/AI_SDK_GOOGLE_FREE_BILLING_PROOF_INVALID/);
  assert.match(candidate,/billing_enabled:billingEnabled==='false'\?false:null/);
});

test('Google-free inference receives no repository or Overcenter authority',()=>{
  assert.doesNotMatch(workflow,/contents: write|pull-requests: write|statuses: write/);
  assert.match(workflow,/persist-credentials: false/g);
  assert.match(workflow,/rm -rf "\$GITHUB_WORKSPACE"/);
  assert.match(workflow,/\/usr\/bin\/setpriv[\s\S]*\/usr\/bin\/env -i/);
  assert.match(workflow,/OVERCENTER_REASONING_CREDENTIAL_SOURCE=gcp-api-keys-via-github-oidc/);
  assert.doesNotMatch(workflow,/^\s+GITHUB_TOKEN:\s/m);
  assert.match(candidate,/AI_SDK_GITHUB_TOKEN_FORBIDDEN/);
  assert.match(candidate,/AI_SDK_OVERCENTER_AUTHORITY_FORBIDDEN/);
  assert.match(candidate,/overcenter_authority_present:false/);
  assert.match(candidate,/project_provider_mutation_authority_present:false/);
});

test('AI SDK candidate uses the existing portable candidate contract',()=>{
  assert.match(workflow,/local-model-candidate\.schema\.json/);
  assert.deepEqual(schema.properties.schema,{
    type:'string',
    enum:['overcenter-autonomy-sandbox-candidate/v1'],
  });
  assert.equal(schema.properties.writes.items.properties.path.type,'string');
  assert.equal(schema.properties.deletes.items.type,'string');
  assert.match(candidate,/Output\.object/);
  assert.match(candidate,/jsonSchema\(schema\)/);
});

test('Google-free candidate crosses a fresh-runner boundary before settlement',()=>{
  const model=workflow.match(/\n  model:[\s\S]*?\n  verify:/)?.[0]??'';
  const verify=workflow.match(/\n  verify:[\s\S]*$/)?.[0]??'';
  assert.match(model,/Upload untrusted candidate only/);
  assert.doesNotMatch(model,/sandbox-runner\.ts/);
  assert.match(verify,/needs: model/);
  assert.match(verify,/sandbox-runner\.ts/);
  assert.match(verify,/--launcher "\$RUNNER_TEMP\/overcenter-exec"/);
  assert.match(verify,/credential_source!=='gcp-api-keys-via-github-oidc'/);
  assert.match(verify,/billing_enabled!==false/);
  assert.match(verify,/reasoning_process_confinement_proven!==false/);
  assert.match(verify,/reasoning_authority_confinement_proven!==true/);
  assert.match(verify,/promotion_evidence\.eligible!==false/);
});
