import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF=githubProofStateRef('conflicting-effect');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const token=required('GITHUB_TOKEN');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF,githubToken:token});
const id=`guard-${workflowRunId}-${attempt}-ordered-beta`;
const work=kernel.inspect().find(candidate=>candidate.id===id);
assert.ok(work);
assert.equal(work.status,'READY',JSON.stringify(kernel.explain(id)));
const run=kernel.claim(work.id,work.revision);
console.log(JSON.stringify({id,run}));
