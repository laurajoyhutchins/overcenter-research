import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF=githubProofStateRef('conflicting-effect');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path:string,init:RequestInit={}):Promise<Response> {
  const token=required('GITHUB_TOKEN');
  return fetch(`https://api.github.com${path}`,{
    ...init,
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
    },
  });
}

const slot=required('SLOT');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF});
const work=kernel.inspect().find(candidate=>candidate.id.endsWith(`-${slot}`) && candidate.status==='EXECUTING');
assert.ok(work);
assert.ok(work.run_id);
assert.equal(work.postcondition.verifier,'github-commit-status/v2');
if (work.postcondition.verifier!=='github-commit-status/v2') throw new Error('WRONG_VERIFIER');

const writtenContext=process.env.WRITE_CONTEXT_CASE==='upper'
  ? work.postcondition.context.toUpperCase()
  : work.postcondition.context;

const response=await github(
  `/repos/${work.postcondition.repository_full_name}/statuses/${work.postcondition.commit_sha}`,
  {
    method:'POST',
    body:JSON.stringify({
      state:work.postcondition.expected_state,
      context:writtenContext,
      description:`Conflict counterexample ${slot}`,
    }),
  },
);
if (response.status!==201) throw new Error(`status write failed: ${response.status} ${await response.text()}`);
console.log(JSON.stringify({
  slot,
  run_id:work.run_id,
  state:work.postcondition.expected_state,
  expected_context:work.postcondition.context,
  written_context:writtenContext,
}));
process.exit(86);
