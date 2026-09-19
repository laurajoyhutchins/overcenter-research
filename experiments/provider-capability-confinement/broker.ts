import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  bindTaskSession,
  executeEffectReady,
} from '../../src/effect-broker.ts';
import { validateEffectReadySignal } from '../../src/execution-signal.ts';
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
const token=required('GITHUB_TOKEN');
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

const session=bindTaskSession(work);
const filenames=readdirSync('candidate-signals')
  .filter(name=>name.endsWith('.json') && name!=='worker-proof.json')
  .sort();
assert.ok(filenames.includes('valid.json'));

let rejected=0;
let validSignal:unknown=null;
for (const filename of filenames) {
  const candidate=JSON.parse(
    readFileSync('candidate-signals/'+filename,'utf8'),
  );
  if (filename==='valid.json') {
    validSignal=validateEffectReadySignal(candidate);
    continue;
  }
  assert.throws(
    ()=>validateEffectReadySignal(candidate),
    /EFFECT_READY_SIGNAL_INVALID/,
    filename+' unexpectedly crossed worker protocol validation',
  );
  rejected+=1;
}
assert.equal(rejected,filenames.length-1);
assert.ok(validSignal);

const afterRejections=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.equal(afterRejections?.execution_generation,1);
assert.equal(afterRejections?.status,'EXECUTING');

let providerWrites=0;
const countedFetch:typeof fetch=async(input,init)=>{
  if (
    init?.method==='POST'
    && String(input).includes('/statuses/')
  ) {
    providerWrites+=1;
  }
  return fetch(input,init);
};

const first=await executeEffectReady(
  kernel,
  session,
  validSignal,
  {
    githubToken:token,
    githubFetch:countedFetch,
  },
);
assert.equal(first.broker_execution_generation,2);
assert.equal(providerWrites,1);
assert.equal(first.effect.repository_id,work.postcondition.repository_id);
assert.equal(first.effect.commit_sha,work.postcondition.commit_sha);
assert.equal(first.effect.context,work.postcondition.context);
assert.equal(first.effect.state,work.postcondition.expected_state);

await assert.rejects(
  executeEffectReady(
    kernel,
    session,
    validSignal,
    {
      githubToken:token,
      githubFetch:countedFetch,
    },
  ),
  /TASK_SESSION_STALE/,
);
assert.equal(providerWrites,1);

const refreshed=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.ok(refreshed);
assert.equal(refreshed.execution_generation,2);
const replaySession=bindTaskSession(refreshed);

await assert.rejects(
  executeEffectReady(
    kernel,
    replaySession,
    validSignal,
    {
      githubToken:token,
      githubFetch:countedFetch,
    },
  ),
  /UNRESOLVED_EFFECT/,
);
assert.equal(providerWrites,1);

const afterReplay=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.equal(afterReplay?.execution_generation,3);

const repositoryResponse=await github(
  '/repositories/'+work.postcondition.repository_id,
);
assert.equal(repositoryResponse.status,200);
const repository=await repositoryResponse.json() as {
  id:number;
  full_name:string;
};
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
const allowed=statuses.filter(
  status=>status.context===work.postcondition.context,
);
const forbidden=statuses.filter(
  status=>status.context===work.postcondition.context+'/forged',
);
assert.equal(allowed.length,1);
assert.equal(allowed[0]?.state,'success');
assert.equal(
  allowed[0]?.description,
  'Overcenter authorized effect broker',
);
assert.equal(forbidden.length,0);

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Trusted capability broker',
    '',
    '- Rejected '+rejected+' attempts to smuggle authority fields into the two-field worker protocol.',
    '- Bound the legal signal to the exact run and generation using server-side authoritative state.',
    '- Executed one provider mutation derived from the authoritative postcondition.',
    '- Rejected the original stale session before authority acquisition.',
    '- A freshly bound generation-2 session still hit UNRESOLVED_EFFECT before a second provider write.',
    '- Provider records at authorized coordinate: '+allowed.length+'.',
    '- Provider records at forged coordinate: '+forbidden.length+'.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  rejected_signals:rejected,
  provider_calls:providerWrites,
  authorized_records:allowed.length,
  forged_records:forbidden.length,
  stale_session_rejected:true,
  execution_generation_after_replay_attempt:afterReplay?.execution_generation,
}));

process.exit(86);
