import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
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
const brokerOutcome=required('BROKER_OUTCOME');
assert.equal(brokerOutcome,'failure');

const stateRef=githubProofStateRef('provider-capability-confinement');
const token=required('GITHUB_TOKEN');
const kernel=new GitOvercenterKernel(process.cwd(),{
  remote:'origin',
  ref:stateRef,
  githubToken:token,
});

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
assert.equal(work.execution_generation,3);
assert.equal(work.postcondition.verifier,'github-commit-status/v1');
if (work.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha,sourceSha);

const recoveryPermit=kernel.acquireExecution(work.run_id);
assert.equal(recoveryPermit.execution_generation,4);
const interrupted=kernel.recoverInterrupted(recoveryPermit,{
  source:'capability-confinement-broker-supervisor',
  outcome:brokerOutcome,
});
assert.equal(interrupted.disposition,'RECOVERY_REQUIRED');

const settled=kernel.reconcile(recoveryPermit);
assert.equal(settled.disposition,'DONE');
assert.equal(settled.verified,true);
assert.equal(settled.observed?.context,work.postcondition.context);
assert.equal(settled.observed?.actual_state,'success');

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
const forbidden=statuses.filter(
  status=>status.context===work.postcondition.context+'/forged',
);
assert.equal(allowed.length,1);
assert.equal(allowed[0]?.state,'success');
assert.equal(forbidden.length,0);

const receipts=kernel.receipts(work.run_id);
assert.deepEqual(
  receipts.map(receipt=>receipt.disposition),
  ['RECOVERY_REQUIRED','DONE'],
);

const final=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.equal(final?.status,'DONE');

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Capability confinement recovery',
    '',
    '- Recovered run at execution generation '+recoveryPermit.execution_generation+'.',
    '- Canonical provider readback verified the one authorized mutation.',
    '- Authorized coordinate contains exactly one status record for this proof run.',
    '- Forged coordinate contains zero status records.',
    '- Final disposition: DONE.',
    '',
  ].join('\n'));
}
