import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow=readFileSync(new URL('../../.github/workflows/autonomy-sandbox-google-free.yml',import.meta.url),'utf8');
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

test('Google-free inference receives no repository or Overcenter authority',()=>{
  assert.match(workflow,/permissions:\n  contents: read/);
  assert.doesNotMatch(workflow,/contents: write|pull-requests: write|statuses: write/);
  assert.match(workflow,/persist-credentials: false/g);
  assert.match(workflow,/rm -rf "\$GITHUB_WORKSPACE"/);
  assert.match(workflow,/\/usr\/bin\/setpriv[\s\S]*\/usr\/bin\/env -i/);
  assert.match(workflow,/GOOGLE_GENERATIVE_AI_API_KEY/);
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
  assert.match(verify,/reasoning_process_confinement_proven!==false/);
  assert.match(verify,/reasoning_authority_confinement_proven!==true/);
  assert.match(verify,/promotion_evidence\.eligible!==false/);
});
