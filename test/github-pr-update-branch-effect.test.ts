import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/kernel.ts';
import type { Postcondition } from '../src/model.ts';
import {
  observationVerified,
  observePostcondition,
  observePostconditionAsync,
} from '../src/observation.ts';
import {
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
  performGithubPullRequestUpdateBranchEffect,
  type GithubUpdateBranchPut,
} from '../src/providers/github-pr-update-branch-effect.ts';

const HEAD='a'.repeat(40);
const BASE='b'.repeat(40);
const NEXT='c'.repeat(40);

function repository(){return {id:42,node_id:'R_42',full_name:'acme/widget',name:'widget',owner:{login:'acme'}};}
function pull(head=HEAD,baseSha=BASE){return {id:3700,node_id:'PR_node_37',number:37,state:'open',head:{sha:head},base:{ref:'main',sha:baseSha}};}
function postcondition():Extract<Postcondition,{verifier:'github-pull-request-branch-updated/v1'}>{
  return {
    verifier:'github-pull-request-branch-updated/v1',
    provider:'github',
    repository_id:42,
    repository_full_name:'acme/widget',
    pull_number:37,
    pull_node_id:'PR_node_37',
    expected_previous_head_sha:HEAD,
    base_ref:'main',
    expected_base_sha:BASE,
  };
}
function compare(ancestor:string,descendant:string,isAncestor=true){
  return {
    status:isAncestor?'ahead':'diverged',
    ahead_by:1,
    behind_by:isAncestor?0:1,
    base_commit:{sha:ancestor},
    merge_base_commit:{sha:isAncestor?ancestor:'d'.repeat(40)},
  };
}

function define(kernel:OvercenterKernel,effectContract:unknown=GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT){
  kernel.initialize();
  kernel.define({
    id:'refresh-pr',
    packet:{effect_contract:effectContract},
    postcondition:postcondition(),
  });
  const work=kernel.deriveReadyWork(); assert.ok(work);
  return kernel.claim(work.id,work.revision);
}

test('trusted PR refresh certifies exact identity, reserves, and sends expected_head_sha',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-pr-refresh-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  const calls:string[]=[];
  try {
    const run=define(kernel);
    const get=async(_token:string,path:string)=>{
      calls.push('GET '+path);
      if(path==='/repos/acme/widget') return repository();
      if(path==='/repos/acme/widget/pulls/37') return pull();
      throw new Error('unexpected');
    };
    const put:GithubUpdateBranchPut=async(_token,path,body)=>{
      assert.equal(kernel.hasUnresolvedEffect(run.id),true);
      calls.push('PUT '+path+' '+body.expected_head_sha);
      return {status:202,body:JSON.stringify({message:'Updating pull request branch.'})};
    };
    const result=await performGithubPullRequestUpdateBranchEffect(kernel,run,{token:'token',get,put});
    assert.equal(result.previous_head_sha,HEAD);
    assert.deepEqual(calls,[
      'GET /repos/acme/widget',
      'GET /repos/acme/widget/pulls/37',
      `PUT /repos/acme/widget/pulls/37/update-branch ${HEAD}`,
    ]);
  } finally { kernel.close(); rmSync(root,{recursive:true,force:true}); }
});

test('head drift fails before reservation and PUT',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-pr-refresh-stale-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  let puts=0;
  try {
    const run=define(kernel);
    await assert.rejects(performGithubPullRequestUpdateBranchEffect(kernel,run,{
      token:'token',
      get:async(_token,path)=>path==='/repos/acme/widget'?repository():pull(NEXT),
      put:async()=>{puts+=1; return {status:202,body:'{}'};},
    }),/GITHUB_PR_UPDATE_BRANCH_IDENTITY_NOT_CURRENT/);
    assert.equal(puts,0);
    assert.equal(kernel.hasUnresolvedEffect(run.id),false);
  } finally { kernel.close(); rmSync(root,{recursive:true,force:true}); }
});

test('missing semantic grant fails before provider I/O',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-pr-refresh-grant-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  let reads=0,puts=0;
  try {
    const run=define(kernel,'other-effect');
    await assert.rejects(performGithubPullRequestUpdateBranchEffect(kernel,run,{
      token:'token',
      get:async()=>{reads+=1; return repository();},
      put:async()=>{puts+=1; return {status:202,body:'{}'};},
    }),/GITHUB_PR_UPDATE_BRANCH_EFFECT_NOT_AUTHORIZED/);
    assert.equal(reads,0); assert.equal(puts,0);
  } finally { kernel.close(); rmSync(root,{recursive:true,force:true}); }
});


test('async postcondition proves old head and requested base are ancestors of the new head',async()=>{
  const p=postcondition();
  const calls:string[]=[];
  const observed=await observePostconditionAsync(p,{
    githubToken:'token',
    githubGetAsync:async(_token,path)=>{
      calls.push(path);
      if(path==='/repos/acme/widget') return repository();
      if(path==='/repos/acme/widget/pulls/37') return pull(NEXT);
      if(path===`/repos/acme/widget/compare/${HEAD}...${NEXT}`) return compare(HEAD,NEXT);
      if(path===`/repos/acme/widget/compare/${BASE}...${NEXT}`) return compare(BASE,NEXT);
      throw new Error('unexpected provider path: '+path);
    },
  });
  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observationVerified(p,observed),true);
  assert.deepEqual(calls,[
    '/repos/acme/widget',
    '/repos/acme/widget/pulls/37',
    `/repos/acme/widget/compare/${HEAD}...${NEXT}`,
    `/repos/acme/widget/compare/${BASE}...${NEXT}`,
  ]);
});

test('unrelated PR head movement cannot counterfeit an update-branch realization',()=>{
  const p=postcondition();
  const observed=observePostcondition(p,{
    githubToken:'token',
    githubGet:(_token,path)=>{
      if(path==='/repos/acme/widget') return repository();
      if(path==='/repos/acme/widget/pulls/37') return pull(NEXT);
      if(path===`/repos/acme/widget/compare/${HEAD}...${NEXT}`) return compare(HEAD,NEXT,false);
      if(path===`/repos/acme/widget/compare/${BASE}...${NEXT}`) return compare(BASE,NEXT);
      throw new Error('unexpected provider path: '+path);
    },
  });
  assert.equal(observed.mutation_certainty,'uncertain');
  assert.equal(observed.observation_error,'GITHUB_PR_BRANCH_UPDATE_ANCESTRY_NOT_ESTABLISHED');
  assert.equal(observationVerified(p,observed),false);
});

test('later base advancement does not erase a proven exact-base realization',()=>{
  const p=postcondition();
  const laterBase='e'.repeat(40);
  const observed=observePostcondition(p,{
    githubToken:'token',
    githubGet:(_token,path)=>{
      if(path==='/repos/acme/widget') return repository();
      if(path==='/repos/acme/widget/pulls/37') return pull(NEXT,laterBase);
      if(path===`/repos/acme/widget/compare/${HEAD}...${NEXT}`) return compare(HEAD,NEXT);
      if(path===`/repos/acme/widget/compare/${BASE}...${NEXT}`) return compare(BASE,NEXT);
      throw new Error('unexpected provider path: '+path);
    },
  });
  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observationVerified(p,observed),true);
});
