import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

const STATE_REF='refs/overcenter/conflict-state';

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

const token=required('GITHUB_TOKEN');
const repository=required('GITHUB_REPOSITORY');
const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF,githubToken:token});
const works=kernel.inspect().filter(work=>work.id.startsWith('conflict-'));
const currentRun=required('GITHUB_RUN_ID');
const currentAttempt=required('GITHUB_RUN_ATTEMPT');
const current=works.filter(work=>work.id.startsWith(`conflict-${currentRun}-${currentAttempt}-`));
assert.equal(current.length,2);
assert.ok(current.every(work=>work.status==='DONE'));

const alpha=current.find(work=>work.id.endsWith('-alpha'))!;
const beta=current.find(work=>work.id.endsWith('-beta'))!;
assert.ok(alpha.run_id && beta.run_id);
const alphaReceipt=kernel.receipts(alpha.run_id).at(-1)!;
const betaReceipt=kernel.receipts(beta.run_id).at(-1)!;
assert.equal(alphaReceipt.observed?.actual_state,'success');
assert.equal(betaReceipt.observed?.actual_state,'failure');

if (alpha.postcondition.verifier!=='github-commit-status/v1') throw new Error('WRONG_ALPHA_VERIFIER');
const repoInfo=await github(`/repositories/${alpha.postcondition.repository_id}`);
const statuses=await github(
  `/repos/${repoInfo.full_name}/commits/${alpha.postcondition.commit_sha}/statuses?per_page=100`,
);
const latest=statuses.find((status:any)=>status.context===alpha.postcondition.context);
assert.equal(latest.state,'failure');

console.log(JSON.stringify({
  counterexample:true,
  alpha:{status:alpha.status,settled_state:alphaReceipt.observed?.actual_state},
  beta:{status:beta.status,settled_state:betaReceipt.observed?.actual_state},
  provider_now:latest.state,
  authority:kernel.head(),
}));
