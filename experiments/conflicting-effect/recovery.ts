import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';

const STATE_REF=githubProofStateRef('conflicting-effect');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const slot=required('SLOT');
const outcome=required('AGENT_OUTCOME');
const token=required('GITHUB_TOKEN');
if (outcome!=='failure') throw new Error(`AGENT_DID_NOT_TERMINATE: ${outcome}`);

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF,githubToken:token});
const work=kernel.inspect().find(candidate=>candidate.id.endsWith(`-${slot}`) && candidate.status==='EXECUTING');
assert.ok(work);
assert.ok(work.run_id);

const permit=kernel.acquireExecution(work.run_id);
kernel.recoverInterrupted(permit,{source:'github-actions-job-supervisor',slot,outcome});
const receipt=kernel.reconcile(permit);
assert.equal(receipt.disposition,'DONE');
assert.equal(receipt.verified,true);
console.log(JSON.stringify({slot,receipt}));
