import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { bindTaskSession, executeAuthorizedEffect } from '../../src/effect-broker.ts';
import { workerResult } from '../../src/worker-result.ts';

const STATE_REF=githubProofStateRef('conflicting-effect');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const slot=required('SLOT');
const token=required('GITHUB_TOKEN');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF});
const work=kernel.inspect().find(candidate=>candidate.id.endsWith(`-${slot}`) && candidate.status==='EXECUTING');
assert.ok(work);
assert.ok(work.run_id);
assert.equal(work.postcondition.verifier,'github-commit-status/v1');

const session=bindTaskSession(work);
const result={
  kind:'conflicting-effect-authorized-result/v1',
  obligation_id:work.id,
};
const acceptedWorkerResult=kernel.acceptWorkerResult(
  session,
  workerResult(session,result),
);
const attempt=await executeAuthorizedEffect(
  kernel,
  session,
  {githubToken:token},
);

assert.equal(attempt.evidence.provider,'github');
assert.equal(attempt.evidence.operation,'create-commit-status');
assert.equal(attempt.evidence.repository_id,work.postcondition.repository_id);
assert.equal(attempt.evidence.commit_sha,work.postcondition.commit_sha);
assert.equal(attempt.evidence.context.toLowerCase(),work.postcondition.context.toLowerCase());
assert.equal(attempt.evidence.state,work.postcondition.expected_state);
assert.equal(kernel.hasUnresolvedEffect(session.run_id),true);

console.log(JSON.stringify({
  slot,
  run_id:work.run_id,
  worker_generation:session.execution_generation,
  broker_generation:attempt.broker_execution_generation,
  worker_result_commit:acceptedWorkerResult.worker_result_commit,
  reservation_commit:attempt.reservation_commit,
  effect_digest:attempt.authorized_effect.effect_digest,
  state:work.postcondition.expected_state,
  context:work.postcondition.context,
}));
process.exit(86);
