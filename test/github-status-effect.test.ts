import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
  type GithubStatusPost,
} from '../src/providers/github-status-effect.ts';
import type { GithubJsonGet } from '../src/providers/github-rest.ts';

const COMMIT='a'.repeat(40);

function repository(id=42) {
  return {
    id,
    node_id:`R_${id}`,
    full_name:'acme/widget',
    name:'widget',
    owner:{login:'acme'},
  };
}

function status() {
  return {
    id:7,
    node_id:'STATUS_7',
    state:'success',
    context:'overcenter/proof',
    target_url:null,
    created_at:'2026-09-20T20:00:00Z',
    updated_at:'2026-09-20T20:00:01Z',
  };
}

function define(kernel:OvercenterKernel,effectContract:unknown=GITHUB_COMMIT_STATUS_EFFECT) {
  kernel.initialize();
  kernel.define({
    id:'status-proof',
    packet:{effect_contract:effectContract},
    postcondition:{
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:42,
      repository_full_name:'acme/widget',
      commit_sha:COMMIT,
      context:'overcenter/proof',
      expected_state:'success',
    },
  });
  const work=kernel.deriveReadyWork();
  assert.ok(work);
  return kernel.claim(work.id,work.revision);
}

test('production GitHub status effect derives provider coordinates from authority and reserves before POST',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-status-effect-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  const calls:Array<{kind:'get'|'post';path:string;body?:unknown}>=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push({kind:'get',path});
    assert.equal(path,'/repos/acme/widget');
    return repository();
  };
  try {
    const run=define(kernel);
    const post:GithubStatusPost=async(_token,path,body)=>{
      calls.push({kind:'post',path,body});
      assert.equal(kernel.hasUnresolvedEffect(run.id),true);
      return {status:201,body:'{}'};
    };
    const result=await performGithubCommitStatusEffect(kernel,run,{
      token:'token',
      get,
      post,
      clock:()=> '2026-09-20T20:00:00.000Z',
    });

    assert.deepEqual(result,{
      repository_id:42,
      repository_full_name:'acme/widget',
      commit_sha:COMMIT,
      context:'overcenter/proof',
      state:'success',
    });
    assert.deepEqual(calls,[
      {kind:'get',path:'/repos/acme/widget'},
      {
        kind:'post',
        path:`/repos/acme/widget/statuses/${COMMIT}`,
        body:{
          state:'success',
          context:'overcenter/proof',
          description:'Overcenter trusted effect broker',
        },
      },
    ]);
    assert.equal(kernel.hasUnresolvedEffect(run.id),true);
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('repository identity mismatch fails before reservation or mutation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-status-identity-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  let posts=0;

  try {
    const run=define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel,run,{
        token:'token',
        get:()=>repository(43),
        post:async()=>{
          posts+=1;
          return {status:201,body:'{}'};
        },
      }),
      /GITHUB_REPOSITORY_IDENTITY_MISMATCH/,
    );
    assert.equal(posts,0);
    assert.equal(kernel.hasUnresolvedEffect(run.id),false);
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('missing effect grant fails before provider I/O',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-status-grant-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  let reads=0;
  let posts=0;

  try {
    const run=define(kernel,'other-effect');
    await assert.rejects(
      performGithubCommitStatusEffect(kernel,run,{
        token:'token',
        get:()=>{
          reads+=1;
          return repository();
        },
        post:async()=>{
          posts+=1;
          return {status:201,body:'{}'};
        },
      }),
      /GITHUB_STATUS_EFFECT_NOT_AUTHORIZED/,
    );
    assert.equal(reads,0);
    assert.equal(posts,0);
    assert.equal(kernel.hasUnresolvedEffect(run.id),false);
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('lost broker acknowledgement survives SQLite reopen and settles from authoritative GitHub readback',async()=>{
  const root=mkdtempSync(join(tmpdir(),'github-status-recovery-'));
  const database=join(root,'overcenter.sqlite');
  const first=new OvercenterKernel(database);
  let providerState:'missing'|'success'='missing';

  try {
    const run=define(first);
    await performGithubCommitStatusEffect(first,run,{
      token:'token',
      get:()=>repository(),
      post:async()=>{
        providerState='success';
        return {status:201,body:'{}'};
      },
    });
    assert.equal(first.hasUnresolvedEffect(run.id),true);
    first.close();

    const get:GithubJsonGet=(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      if (path===`/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
        const statuses=providerState==='success'?[status()]:[];
        return {
          state:providerState==='success'?'success':'pending',
          sha:COMMIT,
          total_count:statuses.length,
          repository:repository(),
          statuses,
        };
      }
      assert.match(path,new RegExp(`^/repos/acme/widget/commits/${COMMIT}/statuses\\?page=1&per_page=30$`));
      return providerState==='success'?[status()]:[];
    };
    const fresh=new OvercenterKernel(database,{
      githubToken:'token',
      observationContext:{githubGet:get},
    });
    try {
      const recoveryPermit=fresh.acquireExecution(run.id);
      assert.equal(recoveryPermit.execution_generation,2);
      const interrupted=fresh.recoverInterrupted(recoveryPermit,{source:'broker-supervisor'});
      assert.equal(interrupted.disposition,'RECOVERY_REQUIRED');
      const settled=fresh.reconcile(recoveryPermit);
      assert.equal(settled.disposition,'DONE');
      assert.equal(settled.verified,true);
      assert.equal(fresh.inspect()[0].status,'DONE');
      assert.deepEqual(
        fresh.receipts(run.id).map(receipt=>receipt.disposition),
        ['RECOVERY_REQUIRED','DONE'],
      );
    } finally {
      fresh.close();
    }
  } finally {
    try { first.close(); } catch {}
    rmSync(root,{recursive:true,force:true});
  }
});
