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

const alpha=ordered.find(work=>work.id.endsWith('-alpha'))!;
const beta=ordered.find(work=>work.id.endsWith('-beta'))!;

// Both effects settled historically. Beta then changes the same mutable
// provider coordinate, so alpha's historical success is no longer current.
assert.equal(alpha.status,'READY',JSON.stringify(kernel.explain(alpha.id)));
assert.equal(beta.status,'DONE',JSON.stringify(kernel.explain(beta.id)));

const receipts=kernel.receipts();
const alphaDone=receipts.filter(receipt=>receipt.obligation_id===alpha.id && receipt.disposition==='DONE').at(-1);
const betaDone=receipts.filter(receipt=>receipt.obligation_id===beta.id && receipt.disposition==='DONE').at(-1);
assert.equal(alphaDone?.observed?.actual_state,'success');
assert.equal(betaDone?.observed?.actual_state,'failure');

if (beta.postcondition.verifier!=='github-commit-status/v2') throw new Error('WRONG_VERIFIER');
const statuses=await github(
  `/repos/${beta.postcondition.repository_full_name}/commits/${beta.postcondition.commit_sha}/statuses?per_page=100`,
);
const latest=statuses.find((status:any)=>status.context===beta.postcondition.context);
assert.equal(latest.state,'failure');

console.log(JSON.stringify({
  unordered:{admitted:unordered.map(work=>({id:work.id,status:work.status})),rejected:[uBetaId]},
  ordered:ordered.map(work=>({id:work.id,status:work.status,run_id:work.run_id})),
  provider_now:latest.state,
  authority:kernel.head(),
}));
