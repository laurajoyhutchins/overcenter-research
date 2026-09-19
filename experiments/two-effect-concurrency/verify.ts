import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';

const STATE_REF=githubProofStateRef('two-effect-concurrency');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const token=required('GITHUB_TOKEN');

const kernel=new GitOvercenterKernel(process.cwd(),{
  remote:'origin',
  ref:STATE_REF,
  githubToken:token,
});

const works=kernel.inspect().filter(candidate=>{
  const executor=candidate.packet.executor as Record<string,unknown>|undefined;
  return executor?.provider==='github-actions/v1'
    && String(executor.workflow_run_id)===workflowRunId
    && String(executor.workflow_run_attempt)===attempt;
});
assert.equal(works.length,2);
assert.deepEqual(works.map(work=>work.status).sort(),['DONE','DONE']);
assert.deepEqual(
  works.map(work=>(work.packet.executor as Record<string,unknown>).slot).sort(),
  ['alpha','beta'],
);

for (const work of works) {
  assert.ok(work.run_id);
  const receipt=kernel.receipts(work.run_id).at(-1);
  assert.ok(receipt);
  assert.equal(receipt.disposition,'DONE');
  assert.equal(receipt.verified,true);
  assert.equal(receipt.run_id,work.run_id);
  assert.equal(receipt.obligation_id,work.id);
  assert.equal(receipt.claimed_revision,work.claimed_revision);
  assert.ok(receipt.claim_commit);
  assert.equal(receipt.observed?.actual_state,'success');
}

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary,[
  '## Two-effect result',
  '',
  ...works.map(work=>{
    const slot=(work.packet.executor as Record<string,unknown>).slot;
    const receipt=kernel.receipts(work.run_id!).at(-1)!;
    return `- ${slot}: **DONE**, run \`${work.run_id}\`, claim \`${receipt.claim_commit}\``;
  }),
  `- Final authority: \`${kernel.head()}\``,
  '- Both effects overlapped, both workers died, and both were independently recovered through one linear Git authority ref.',
  '',
].join('\n'));

console.log(JSON.stringify({
  state_ref:STATE_REF,
  authority:kernel.head(),
  works:works.map(work=>({
    id:work.id,
    status:work.status,
    run_id:work.run_id,
    claim_commit:work.claim_commit,
  })),
}));
