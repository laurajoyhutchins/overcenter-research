import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF=required('STATE_REF');

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

const repository=required('GITHUB_REPOSITORY');
const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const sha=required('GITHUB_SHA');
const info=await github(`/repos/${repository}`);
const unorderedContext=`overcenter/conflict-guard/${workflowRunId}/${attempt}/unordered`;
const orderedContext=`overcenter/conflict-guard/${workflowRunId}/${attempt}/ordered`;

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF});
kernel.initialize();

const statusPc=(context:string,state:'success'|'failure')=>({
  verifier:'github-commit-status/v1' as const,
  provider:'github' as const,
  repository_id:info.id,
  commit_sha:sha,
  context,
  expected_state:state,
});

const uAlpha=`guard-${workflowRunId}-${attempt}-unordered-alpha`;
const uBeta=`guard-${workflowRunId}-${attempt}-unordered-beta`;
kernel.define({id:uAlpha,postcondition:statusPc(`${unorderedContext}/Build`,'success')});
kernel.define({id:uBeta,postcondition:statusPc(`${unorderedContext}/build`,'failure')});

const uWork=kernel.inspect().find(work=>work.id===uAlpha)!;
assert.throws(
  ()=>kernel.claim(uWork.id,uWork.revision),
  /UNORDERED_EFFECT_CONFLICT/,
);
const unordered=kernel.inspect().filter(work=>work.id===uAlpha||work.id===uBeta);
assert.ok(unordered.every(work=>work.status==='BLOCKED' && !work.run_id && work.blocked_reason?.startsWith('UNORDERED_EFFECT_CONFLICT:')));

const oAlpha=`guard-${workflowRunId}-${attempt}-ordered-alpha`;
const oBeta=`guard-${workflowRunId}-${attempt}-ordered-beta`;
kernel.define({id:oAlpha,postcondition:statusPc(orderedContext,'success')});
kernel.define({id:oBeta,dependencies:[{kind:'control',upstream:oAlpha}],postcondition:statusPc(orderedContext,'failure')});

const alpha=kernel.inspect().find(work=>work.id===oAlpha)!;
const run=kernel.claim(alpha.id,alpha.revision);

console.log(JSON.stringify({
  state_ref:STATE_REF,
  unordered:{alpha:uAlpha,beta:uBeta,contexts:[`${unorderedContext}/Build`,`${unorderedContext}/build`]},
  ordered:{alpha:oAlpha,beta:oBeta,context:orderedContext,alpha_run:run},
}));
