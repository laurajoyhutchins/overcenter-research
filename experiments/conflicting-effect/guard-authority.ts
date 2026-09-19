import { githubProofStateRef } from '../proof-environment.ts';
import assert from 'node:assert/strict';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { canonicalDigest } from '../../src/digest.ts';
import { githubCommitStatusEffectAuthority } from '../../src/provider-effect.ts';

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

const effectObligation=(id:string,context:string,state:'success'|'failure')=>({
  id,
  postcondition:statusPc(context,state),
  effect_authority:githubCommitStatusEffectAuthority(),
  result_acceptance:{
    verifier:'canonical-json-sha256/v1' as const,
    expected_sha256:canonicalDigest({
      kind:'conflicting-effect-authorized-result/v1',
      obligation_id:id,
    }),
  },
});

const uAlpha=`guard-${workflowRunId}-${attempt}-unordered-alpha`;
const uBeta=`guard-${workflowRunId}-${attempt}-unordered-beta`;
kernel.define(effectObligation(uAlpha,`${unorderedContext}/Build`,'success'));
const headAfterAlpha=kernel.head();
assert.ok(headAfterAlpha);

assert.throws(
  ()=>kernel.define(effectObligation(
    uBeta,
    `${unorderedContext}/build`,
    'failure',
  )),
  /UNORDERED_EFFECT_CONFLICT/,
);
assert.equal(
  kernel.head(),
  headAfterAlpha,
  'rejected admission must not advance authority',
);

const unordered=kernel.inspect().filter(work=>work.id===uAlpha||work.id===uBeta);
assert.equal(unordered.length,1);
assert.equal(unordered[0]?.id,uAlpha);
assert.equal(unordered[0]?.status,'READY');
assert.equal(unordered[0]?.run_id,undefined);
assert.equal(
  kernel.inspect().some(work=>work.id===uBeta),
  false,
  'conflicting beta must never enter authority',
);

const oAlpha=`guard-${workflowRunId}-${attempt}-ordered-alpha`;
const oBeta=`guard-${workflowRunId}-${attempt}-ordered-beta`;
kernel.define(effectObligation(oAlpha,`${orderedContext}/Build`,'success'));
kernel.define({
  ...effectObligation(oBeta,`${orderedContext}/build`,'failure'),
  dependencies:[{kind:'control' as const,upstream:oAlpha}],
});

const alpha=kernel.inspect().find(work=>work.id===oAlpha)!;
const run=kernel.claim(alpha.id,alpha.revision);

console.log(JSON.stringify({
  state_ref:STATE_REF,
  unordered:{admitted:uAlpha,rejected:uBeta,contexts:[`${unorderedContext}/Build`,`${unorderedContext}/build`]},
  ordered:{alpha:oAlpha,beta:oBeta,context:orderedContext,alpha_run:run},
}));
