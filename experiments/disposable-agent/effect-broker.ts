import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  bindTaskSession,
  executeEffectReady,
} from '../../src/effect-broker.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error('missing '+name);
  return value;
}

const workflowRunId=required('GITHUB_RUN_ID');
const workflowRunAttempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('SOURCE_SHA');
const token=required('GITHUB_TOKEN');
const stateRef=githubProofStateRef('disposable-agent');
const candidateSignal=JSON.parse(
  readFileSync('candidate/effect-ready.json','utf8'),
) as unknown;

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:stateRef});
const candidates=kernel.inspect().filter(work=>{
  if (work.status!=='EXECUTING') return false;
  const executor=work.packet.executor as Record<string,unknown>|undefined;
  return executor?.provider==='github-actions/v1'
    && String(executor.workflow_run_id)===workflowRunId
    && String(executor.workflow_run_attempt)===workflowRunAttempt
    && executor.job==='agent-a';
});
assert.equal(candidates.length,1);
const work=candidates[0];
assert.equal(work.postcondition.verifier,'github-commit-status/v1');
if (work.postcondition.verifier!=='github-commit-status/v1') {
  throw new Error('WRONG_VERIFIER');
}
assert.equal(work.postcondition.commit_sha,sourceSha);

const session=bindTaskSession(work);
const attempt=await executeEffectReady(
  kernel,
  session,
  candidateSignal,
  {githubToken:token},
);
assert.equal(attempt.session.run_id,work.run_id);
assert.equal(attempt.effect.commit_sha,sourceSha);
assert.equal(attempt.effect.context,work.postcondition.context);
assert.equal(attempt.effect.state,work.postcondition.expected_state);
assert.equal(attempt.broker_execution_generation,2);

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Trusted effect broker',
    '',
    '- Consumed only a run-bound effect-ready signal.',
    '- Reconstructed the task session from trusted workflow identity and authoritative project state.',
    '- Derived the provider mutation from the authoritative postcondition.',
    '- Durably reserved the effect before the provider mutation.',
    '- Broker now terminates before settlement to force fresh-generation recovery.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id:work.id,
  run_id:work.run_id,
  worker_signal:candidateSignal,
  broker_execution_generation:attempt.broker_execution_generation,
  effect:attempt.effect,
  evidence:attempt.evidence,
}));

process.exit(86);
