import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF=githubProofStateRef('conflicting-effect');

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path:string):Promise<any> {
  const token=required('GITHUB_TOKEN');
  const response=await fetch(`https://api.github.com${path}`,{
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  return response.json();
}

const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const token=required('GITHUB_TOKEN');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF,githubToken:token});
const prefix=`guard-${workflowRunId}-${attempt}-`;
const works=kernel.inspect().filter(work=>work.id.startsWith(prefix));
assert.equal(works.length,3);

const uAlphaId=`${prefix}unordered-alpha`;
const uBetaId=`${prefix}unordered-beta`;
const unordered=works.filter(work=>work.id.includes('-unordered-'));
assert.equal(unordered.length,1);
assert.equal(unordered[0]?.id,uAlphaId);
assert.equal(unordered[0]?.status,'READY');
assert.equal(unordered[0]?.run_id,undefined);
assert.equal(
  works.some(work=>work.id===uBetaId),
  false,
  'conflicting beta must remain outside authority',
);

const ordered=works.filter(work=>work.id.includes('-ordered-'));
assert.equal(ordered.length,2);
assert.ok(ordered.every(work=>work.status==='DONE'));

const alpha=ordered.find(work=>work.id.endsWith('-alpha'))!;
const beta=ordered.find(work=>work.id.endsWith('-beta'))!;
assert.ok(alpha.run_id && beta.run_id);
assert.equal(kernel.receipts(alpha.run_id).at(-1)?.observed?.actual_state,'success');
assert.equal(kernel.receipts(beta.run_id).at(-1)?.observed?.actual_state,'failure');

if (beta.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_VERIFIER');
const repoInfo=await github(`/repositories/${beta.postcondition.repository_id}`);
const statuses=await github(
  `/repos/${repoInfo.full_name}/commits/${beta.postcondition.commit_sha}/statuses?per_page=100`,
);
const latest=statuses.find((status:any)=>status.context===beta.postcondition.context);
assert.equal(latest.state,'failure');

console.log(JSON.stringify({
  unordered:{admitted:unordered.map(work=>({id:work.id,status:work.status})),rejected:[uBetaId]},
  ordered:ordered.map(work=>({id:work.id,status:work.status,run_id:work.run_id})),
  provider_now:latest.state,
  authority:kernel.head(),
}));
