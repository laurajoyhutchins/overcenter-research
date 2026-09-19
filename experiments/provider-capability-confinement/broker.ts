import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  authorizeEffectRequest,
  expectedEffectRequest,
} from '../../src/effect-request.ts';
import { githubProofStateRef } from '../proof-environment.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error('missing '+name);
  return value;
}

async function github(path:string,init:RequestInit={}):Promise<Response> {
  const token=required('GITHUB_TOKEN');
  return fetch('https://api.github.com'+path,{
    ...init,
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
      ...(init.headers??{}),
    },
  });
}

const runId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('SOURCE_SHA');
const stateRef=githubProofStateRef('provider-capability-confinement');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:stateRef});

const candidates=kernel.inspect().filter(work=>{
  if (work.status!=='EXECUTING') return false;
  const executor=work.packet.executor as Record<string,unknown>|undefined;
  return executor?.provider==='github-actions/v1'
    && String(executor.workflow_run_id)===runId
    && String(executor.workflow_run_attempt)===attempt
    && executor.job==='hostile-worker';
});
assert.equal(candidates.length,1);
const work=candidates[0];
assert.ok(work.run_id);
assert.equal(work.execution_generation,1);
assert.equal(work.postcondition.verifier,'github-commit-status/v1');
if (work.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha,sourceSha);

const authoritative=expectedEffectRequest(work);
const filenames=readdirSync('candidate-requests')
  .filter(name=>name.endsWith('.json') && name!=='worker-proof.json')
  .sort();
assert.ok(filenames.includes('valid.json'));

let rejected=0;
for (const filename of filenames) {
  const candidate=JSON.parse(readFileSync('candidate-requests/'+filename,'utf8'));
  if (filename==='valid.json') {
    assert.deepEqual(authorizeEffectRequest(work,candidate),authoritative);
    continue;
  }
  assert.throws(
    ()=>authorizeEffectRequest(work,candidate),
    /EFFECT_REQUEST_NOT_AUTHORIZED/,
    filename+' unexpectedly crossed capability validation',
  );
  rejected+=1;
}
assert.equal(rejected,filenames.length-1);

const afterRejections=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.equal(afterRejections?.execution_generation,1);
assert.equal(afterRejections?.status,'EXECUTING');

const effect=authoritative.effect as Record<string,unknown>;
assert.deepEqual(effect,{
  kind:'github-commit-status/v1',
  repository_id:work.postcondition.repository_id,
  commit_sha:work.postcondition.commit_sha,
  context:work.postcondition.context,
  state:work.postcondition.expected_state,
});

const repositoryResponse=await github('/repositories/'+work.postcondition.repository_id);
assert.equal(repositoryResponse.status,200);
const repository=await repositoryResponse.json() as {id:number;full_name:string};
assert.equal(repository.id,work.postcondition.repository_id);

let providerCalls=0;
const permit=kernel.acquireExecution(work.run_id);
assert.equal(permit.execution_generation,2);

await kernel.performEffect(permit,async()=>{
  providerCalls+=1;
  const response=await github(
    '/repos/'+repository.full_name+'/statuses/'+String(effect.commit_sha),
    {
      method:'POST',
      body:JSON.stringify({
        state:effect.state,
        context:effect.context,
        description:'Overcenter exact capability broker',
      }),
    },
  );
  if (response.status!==201) {
    throw new Error('AUTHORIZED_PROVIDER_MUTATION_FAILED:'+response.status+':'+await response.text());
  }
});
assert.equal(providerCalls,1);

const replayPermit=kernel.acquireExecution(work.run_id);
assert.equal(replayPermit.execution_generation,3);
await assert.rejects(
  kernel.performEffect(replayPermit,async()=>{
    providerCalls+=1;
  }),
  /UNRESOLVED_EFFECT/,
);
assert.equal(providerCalls,1,'replay entered provider callback');

const statusesResponse=await github(
  '/repos/'+repository.full_name+'/commits/'+sourceSha+'/statuses?per_page=100',
);
assert.equal(statusesResponse.status,200);
const statuses=await statusesResponse.json() as Array<{
  id:number;
  context:string;
  state:string;
  description:string|null;
}>;
const allowed=statuses.filter(status=>status.context===work.postcondition.context);
const forbidden=statuses.filter(
  status=>status.context===work.postcondition.context+'/forged',
);
assert.equal(allowed.length,1,'authorized coordinate must have exactly one provider record');
assert.equal(allowed[0]?.state,'success');
assert.equal(allowed[0]?.description,'Overcenter exact capability broker');
assert.equal(forbidden.length,0,'forged coordinate unexpectedly mutated provider');

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Trusted capability broker',
    '',
    '- Rejected '+rejected+' forged requests before authority rotation.',
    '- Executed one authority-derived provider command.',
    '- Fresh-generation replay failed with UNRESOLVED_EFFECT before entering the provider callback.',
    '- Provider records at authorized coordinate: '+allowed.length+'.',
    '- Provider records at forged coordinate: '+forbidden.length+'.',
    '- Broker credential remains repository-scoped; coordinate confinement is enforced by trusted broker plus durable reservation.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  rejected_requests:rejected,
  provider_calls:providerCalls,
  authorized_records:allowed.length,
  forged_records:forbidden.length,
  execution_generation_after_replay_attempt:replayPermit.execution_generation,
}));

process.exit(86);
