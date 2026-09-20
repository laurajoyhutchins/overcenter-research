import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { bindTaskSession } from '../../src/effect-broker.ts';
import { workerResult } from '../../src/realization.ts';
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
const session=bindTaskSession(work);
assert.equal(work.execution_generation,1);
assert.equal(work.postcondition.verifier,'github-commit-status/v1');
if (work.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha,sourceSha);

const repositoryResponse=await github('/repositories/'+work.postcondition.repository_id);
assert.equal(repositoryResponse.status,200);
const repository=await repositoryResponse.json() as {id:number;full_name:string};
assert.equal(repository.id,work.postcondition.repository_id);

const directContexts=[
  work.postcondition.context,
  work.postcondition.context+'/forged',
];
const directStatuses:number[]=[];
for (const context of directContexts) {
  const response=await github(
    '/repos/'+repository.full_name+'/statuses/'+work.postcondition.commit_sha,
    {
      method:'POST',
      body:JSON.stringify({
        state:'success',
        context,
        description:'hostile worker direct mutation must fail',
      }),
    },
  );
  directStatuses.push(response.status);
  assert.equal(response.status,403);
}

const valid=workerResult(session,{
  kind:'provider-capability-confinement-result/v1',
  source_sha:sourceSha,
  authorized_write_status:directStatuses[0],
  forged_write_status:directStatuses[1],
});

const variants:Record<string,unknown>={
  valid,
  'forged-result':workerResult(session,{
    kind:'provider-capability-confinement-result/v1',
    source_sha:sourceSha,
    authorized_write_status:201,
    forged_write_status:201,
  }),
  'target-run':{...structuredClone(valid),run_id:'some-other-run'},
  'target-obligation':{...structuredClone(valid),obligation_id:'some-other-obligation'},
  'target-repository':{...structuredClone(valid),repository_id:work.postcondition.repository_id+1},
  'target-commit':{...structuredClone(valid),commit_sha:'0'.repeat(40)},
  'target-context':{...structuredClone(valid),context:work.postcondition.context+'/forged'},
  'target-state':{...structuredClone(valid),state:'failure'},
  'smuggled-effect':{
    ...structuredClone(valid),
    effect:{
      kind:'github-commit-status/v1',
      context:work.postcondition.context+'/forged',
      state:'failure',
    },
  },
  'extra-result-field':workerResult(session,{
    ...(valid.result as Record<string,unknown>),
    smuggled_provider_argument:'surprise',
  }),
};

mkdirSync('candidate-results',{recursive:true});
for (const [name,value] of Object.entries(variants)) {
  writeFileSync(
    'candidate-results/'+name+'.json',
    JSON.stringify(value,null,2)+'\n',
  );
}
writeFileSync(
  'candidate-results/worker-proof.json',
  JSON.stringify({
    direct_provider_statuses:directStatuses,
    direct_contexts:directContexts,
  },null,2)+'\n',
);

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Hostile reasoning worker',
    '',
    '- Job permission: contents read only.',
    '- Direct writes to authorized and forged coordinates both returned HTTP 403.',
    '- Emitted one acceptable result plus nine forged/smuggled variants.',
    '- Result bytes never select the provider effect.',
    '',
  ].join('\n'));
}
