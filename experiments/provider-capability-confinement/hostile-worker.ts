import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { expectedEffectRequest } from '../../src/effect-request.ts';
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
  assert.equal(response.status,403,'worker unexpectedly mutated provider at '+context);
}

const valid=expectedEffectRequest(work);
const variants:Record<string,unknown>={
  valid,
  'wrong-obligation':{...structuredClone(valid),obligation_id:'other-obligation'},
  'wrong-run':{...structuredClone(valid),run_id:'other-run'},
  'wrong-revision':{...structuredClone(valid),claimed_revision:'forged-revision'},
  'wrong-repository':{
    ...structuredClone(valid),
    effect:{...structuredClone(valid.effect),repository_id:work.postcondition.repository_id+1},
  },
  'wrong-commit':{
    ...structuredClone(valid),
    effect:{...structuredClone(valid.effect),commit_sha:'0'.repeat(40)},
  },
  'wrong-context':{
    ...structuredClone(valid),
    effect:{...structuredClone(valid.effect),context:work.postcondition.context+'/forged'},
  },
  'wrong-state':{
    ...structuredClone(valid),
    effect:{...structuredClone(valid.effect),state:'failure'},
  },
  'wrong-kind':{
    ...structuredClone(valid),
    effect:{...structuredClone(valid.effect),kind:'github-commit-status/v9'},
  },
  'extra-field':{
    ...structuredClone(valid),
    smuggled_provider_argument:'surprise',
  },
};

mkdirSync('candidate-requests',{recursive:true});
for (const [name,value] of Object.entries(variants)) {
  writeFileSync(
    'candidate-requests/'+name+'.json',
    JSON.stringify(value,null,2)+'\n',
  );
}
writeFileSync(
  'candidate-requests/worker-proof.json',
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
    '- Direct mutation of authorized context: HTTP '+directStatuses[0]+'.',
    '- Direct mutation of forged context: HTTP '+directStatuses[1]+'.',
    '- Emitted '+Object.keys(variants).length+' candidate request files, including hand-forged coordinate/state/run variants.',
    '- Worker possesses neither the broker token nor the kernel execution capability secret.',
    '',
  ].join('\n'));
}
