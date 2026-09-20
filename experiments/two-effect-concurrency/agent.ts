import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF=githubProofStateRef('two-effect-concurrency');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path:string,init:RequestInit={}):Promise<Response> {
  const token=required('GITHUB_TOKEN');
  return fetch(`https://api.github.com${path}`,{
    ...init,
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
      ...(init.headers??{}),
    },
  });
}

const slot=required('SLOT');
const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('GITHUB_SHA');

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF});
const work=kernel.inspect().find(candidate=>{
  const executor=candidate.packet.executor as Record<string,unknown>|undefined;
  return candidate.status==='EXECUTING'
    && executor?.provider==='github-actions/v1'
    && String(executor.workflow_run_id)===workflowRunId
    && String(executor.workflow_run_attempt)===attempt
    && executor.slot===slot;
});
assert.ok(work,`missing executing obligation for ${slot}`);
assert.ok(work.run_id);
assert.equal(work.postcondition.verifier,'github-commit-status/v2');
if (work.postcondition.verifier!=='github-commit-status/v2') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha,sourceSha);
assert.equal(
  work.packet.effect_contract,
  'github-commit-status/set-from-postcondition/v1',
);
assert.equal(Object.hasOwn(work.packet,'effect'),false);

const repositoryResponse=await github(`/repositories/${work.postcondition.repository_id}`);
if (!repositoryResponse.ok) throw new Error(`repository lookup failed: ${repositoryResponse.status}`);
const repository=await repositoryResponse.json() as {id:number;full_name:string};
assert.equal(repository.id,work.postcondition.repository_id);
assert.equal(
  repository.full_name.toLowerCase(),
  work.postcondition.repository_full_name.toLowerCase(),
);

const permit=kernel.acquireExecution(work.run_id);
await kernel.performEffect(permit,async()=>{
  const effect=await github(
    `/repos/${repository.full_name}/statuses/${work.postcondition.commit_sha}`,
    {
      method:'POST',
      body:JSON.stringify({
        state:work.postcondition.expected_state,
        context:work.postcondition.context,
        description:`Overcenter concurrent effect ${slot}`,
      }),
    },
  );
  if (effect.status!==201) throw new Error(`status creation failed ${effect.status}: ${await effect.text()}`);
});

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary,[
  `## Trusted effect broker ${slot}`,
  '',
  `- Reconstructed run: \`${work.run_id}\``,
  `- Execution generation: \`${permit.execution_generation}\``,
  `- Provider context: \`${work.postcondition.context}\``,
  '- Effect reserved before provider mutation.',
  '- Broker terminates without settlement.',
  '',
].join('\n'));

console.log(JSON.stringify({slot,run_id:work.run_id,context:work.postcondition.context}));
process.exit(86);
