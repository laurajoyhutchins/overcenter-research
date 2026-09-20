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

const slot=required('SLOT');
const outcome=required('AGENT_OUTCOME');
const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const token=required('GITHUB_TOKEN');

if (outcome!=='failure') throw new Error(`AGENT_DID_NOT_TERMINATE: ${slot} ${outcome}`);

const kernel=new GitOvercenterKernel(process.cwd(),{
  remote:'origin',
  ref:STATE_REF,
  githubToken:token,
});

const work=kernel.inspect().find(candidate=>{
  const executor=candidate.packet.executor as Record<string,unknown>|undefined;
  return candidate.status==='EXECUTING'
    && executor?.provider==='github-actions/v1'
    && String(executor.workflow_run_id)===workflowRunId
    && String(executor.workflow_run_attempt)===attempt
    && executor.slot===slot;
});
assert.ok(work,`missing unresolved run for ${slot}`);
assert.ok(work.run_id);

const permit=kernel.acquireExecution(work.run_id);
const recovery=kernel.recordExecutionTerminated(permit,{
  source:'github-actions-job-supervisor',
  workflow_run_id:workflowRunId,
  workflow_run_attempt:attempt,
  slot,
  outcome,
});
const settled=kernel.reconcile(permit);
assert.equal(settled.disposition,'DONE');
assert.equal(settled.verified,true);
assert.equal(settled.claim_commit,recovery.claim_commit);

const final=kernel.inspect().find(candidate=>candidate.id===work.id);
assert.equal(final?.status,'DONE');

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary,[
  `## Recovery ${slot}`,
  '',
  `- Run: \`${work.run_id}\``,
  `- Exact claim commit: \`${settled.claim_commit}\``,
  `- Settlement: \`${settled.settlement_commit}\``,
  `- Provider state: \`${settled.observed?.actual_state}\``,
  '- Final disposition: **DONE**',
  '',
].join('\n'));

console.log(JSON.stringify({slot,recovery,settled}));
