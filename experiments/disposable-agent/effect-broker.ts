import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  executeAuthorizedEffect,
  validateTaskSession,
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
const session=validateTaskSession(
  JSON.parse(readFileSync('trusted-session/task-session.json','utf8')),
);
const candidateResult=JSON.parse(
  readFileSync('candidate/worker-result.json','utf8'),
) as unknown;

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:stateRef});
const work=kernel.inspect().find(candidate=>candidate.run_id===session.run_id);
assert.ok(work);
const executor=work.packet.executor as Record<string,unknown>|undefined;
assert.equal(String(executor?.workflow_run_id),workflowRunId);
assert.equal(String(executor?.workflow_run_attempt),workflowRunAttempt);
assert.equal(work.postcondition.verifier,'github-commit-status/v1');
if (work.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_VERIFIER');
assert.equal(work.postcondition.commit_sha,sourceSha);

const realization=kernel.acceptRealization(session,candidateResult);
const attempt=await executeAuthorizedEffect(
  kernel,
  session,
  {githubToken:token},
);
assert.equal(attempt.session.run_id,session.run_id);
assert.equal(attempt.authorized_effect.effect.commit_sha,sourceSha);
assert.equal(attempt.authorized_effect.effect.context,work.postcondition.context);
assert.equal(attempt.authorized_effect.effect.state,work.postcondition.expected_state);
assert.equal(attempt.broker_execution_generation,2);

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Trusted effect broker',
    '',
    '- Used the TaskSession minted by trusted dispatch before the worker ran.',
    `- Accepted realization: \`${realization.realization_commit}\`.`,
    '- Derived effect readiness from durable accepted evidence, not a worker readiness claim.',
    `- Reserved exact effect digest: \`${attempt.authorized_effect.effect_digest}\`.`,
    '- Provider command came from explicit effect authority plus the authoritative postcondition.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id:session.obligation_id,
  run_id:session.run_id,
  realization_commit:realization.realization_commit,
  effect_digest:attempt.authorized_effect.effect_digest,
  adapter_contract_digest:attempt.authorized_effect.adapter_contract_digest,
  reservation_commit:attempt.reservation_commit,
  broker_execution_generation:attempt.broker_execution_generation,
  evidence:attempt.evidence,
}));

process.exit(86);
