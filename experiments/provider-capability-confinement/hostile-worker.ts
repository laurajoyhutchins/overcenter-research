import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { effectReadySignal } from '../../src/execution-signal.ts';
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
if (work.postcondition.verifier!=='github-commit-status/v1') {
  throw new Error('WRONG_VERIFIER');
}
assert.equal(work.postcondition.commit_sha,sourceSha);

const repositoryResponse=await github(
  '/repositories/'+work.postcondition.repository_id,
);
assert.equal(repositoryResponse.status,200);
const repository=await repositoryResponse.json() as {
  id:number;
  full_name:string;
};
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
  assert.equal(
    response.status,
    403,
    'worker unexpectedly mutated provider at '+context,
  );
}

const valid=effectReadySignal();
const variants:Record<string,unknown>={
  valid,
  'target-run':{...valid,run_id:'some-other-run'},
  'target-obligation':{...valid,obligation_id:'some-other-obligation'},
  'target-revision':{...valid,claimed_revision:'forged-revision'},
  'target-repository':{...valid,repository_id:work.postcondition.repository_id+1},
  'target-commit':{...valid,commit_sha:'0'.repeat(40)},
  'target-context':{...valid,context:work.postcondition.context+'/forged'},
  'target-state':{...valid,state:'failure'},
  'smuggled-effect':{
    ...valid,
    effect:{
      kind:'github-commit-status/v1',
      repository_id:work.postcondition.repository_id,
      commit_sha:work.postcondition.commit_sha,
      context:work.postcondition.context+'/forged',
      state:'failure',
    },
  },
  'extra-field':{...valid,smuggled_provider_argument:'surprise'},
};

mkdirSync('candidate-signals',{recursive:true});
for (const [name,value] of Object.entries(variants)) {
  writeFileSync(
    'candidate-signals/'+name+'.json',
    JSON.stringify(value,null,2)+'\n',
  );
}
writeFileSync(
  'candidate-signals/worker-proof.json',
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
    '- Emitted one legal effect-ready signal plus nine attempts to smuggle authority-bearing fields.',
    '- Legal signal contains no run, obligation, revision, repository, commit, context, state, or effect payload.',
    '',
  ].join('\n'));
}
