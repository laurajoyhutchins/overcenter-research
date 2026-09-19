import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  bindTaskSession,
  executeAuthorizedEffect,
  validateTaskSession,
} from '../../src/effect-broker.ts';
import { githubProofStateRef } from '../proof-environment.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error('missing '+name);
  return value;
}

async function github(path:string):Promise<Response> {
  const token=required('GITHUB_TOKEN');
  return fetch('https://api.github.com'+path,{
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
    },
  });
}

const runId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('SOURCE_SHA');
const token=required('GITHUB_TOKEN');
const stateRef=githubProofStateRef('provider-capability-confinement');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:stateRef});
const session=validateTaskSession(
  JSON.parse(readFileSync('trusted-session/task-session.json','utf8')),
);

const work=kernel.inspect().find(candidate=>candidate.run_id===session.run_id);
assert.ok(work);
const executor=work.packet.executor as Record<string,unknown>|undefined;
assert.equal(String(executor?.workflow_run_id),runId);
assert.equal(String(executor?.workflow_run_attempt),attempt);
assert.equal(work.execution_generation,1);
assert.equal(work.postcondition.verifier,'github-commit-status/v1');
if (work.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha,sourceSha);

const filenames=readdirSync('candidate-results')
  .filter(name=>name.endsWith('.json') && name!=='worker-proof.json')
  .sort();
assert.ok(filenames.includes('valid.json'));

let rejected=0;
for (const filename of filenames.filter(name=>name!=='valid.json')) {
  const candidate=JSON.parse(readFileSync('candidate-results/'+filename,'utf8'));
  assert.throws(
    ()=>kernel.acceptRealization(session,candidate),
    /WORKER_RESULT_INVALID|WORKER_RESULT_REJECTED/,
    filename+' unexpectedly became accepted realization',
  );
  rejected+=1;
}
assert.equal(rejected,filenames.length-1);
assert.equal(kernel.acceptedRealization(session),null);

const valid=JSON.parse(readFileSync('candidate-results/valid.json','utf8'));
const realization=kernel.acceptRealization(session,valid);
assert.match(realization.result_digest,/^[0-9a-f]{64}$/);

let providerWrites=0;
const countedFetch:typeof fetch=async(input,init)=>{
  if (init?.method==='POST' && String(input).includes('/statuses/')) {
    providerWrites+=1;
  }
  return fetch(input,init);
};

const first=await executeAuthorizedEffect(
  kernel,
  session,
  {githubToken:token,githubFetch:countedFetch},
);
assert.equal(first.broker_execution_generation,2);
assert.equal(providerWrites,1);
assert.equal(first.authorized_effect.effect.repository_id,work.postcondition.repository_id);
assert.equal(first.authorized_effect.effect.commit_sha,work.postcondition.commit_sha);
assert.equal(first.authorized_effect.effect.context,work.postcondition.context);

await assert.rejects(
  executeAuthorizedEffect(
    kernel,
    session,
    {githubToken:token,githubFetch:countedFetch},
  ),
  /TASK_SESSION_STALE/,
);
assert.equal(providerWrites,1);

const refreshed=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.ok(refreshed);
assert.equal(refreshed.execution_generation,2);
const recoverySession=bindTaskSession(refreshed);

await assert.rejects(
  executeAuthorizedEffect(
    kernel,
    recoverySession,
    {githubToken:token,githubFetch:countedFetch},
  ),
  /UNRESOLVED_EFFECT/,
);
assert.equal(providerWrites,1);

const afterReplay=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.equal(afterReplay?.execution_generation,3);

const repositoryResponse=await github('/repositories/'+work.postcondition.repository_id);
assert.equal(repositoryResponse.status,200);
const repository=await repositoryResponse.json() as {id:number;full_name:string};
const statusesResponse=await github(
  '/repos/'+repository.full_name+'/commits/'+sourceSha+'/statuses?per_page=100',
);
assert.equal(statusesResponse.status,200);
const statuses=await statusesResponse.json() as Array<{
  context:string;
  state:string;
  description:string|null;
}>;
const allowed=statuses.filter(status=>status.context===work.postcondition.context);
const forbidden=statuses.filter(status=>status.context===work.postcondition.context+'/forged');
assert.equal(allowed.length,1);
assert.equal(allowed[0]?.state,'success');
assert.equal(forbidden.length,0);

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Trusted capability broker',
    '',
    '- Rejected '+rejected+' forged results before accepting a realization.',
    '- Used the TaskSession minted before worker execution.',
    '- Executed exactly one explicitly authorized provider effect.',
    '- Original dispatch session became stale after authority rotation.',
    '- Fresh recovery authority still could not replay the unresolved exact-effect reservation.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  rejected_results:rejected,
  realization_commit:realization.realization_commit,
  effect_digest:first.authorized_effect.effect_digest,
  provider_calls:providerWrites,
  authorized_records:allowed.length,
  forged_records:forbidden.length,
  stale_session_rejected:true,
  execution_generation_after_replay_attempt:afterReplay?.execution_generation,
}));

process.exit(86);
