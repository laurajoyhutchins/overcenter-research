import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
  type GithubStatusPost,
} from '../../src/providers/github/status-effect.ts';
import type { GithubJsonGet } from '../../src/providers/github/rest.ts';

const COMMIT='a'.repeat(40);
const CLOCK='2026-09-22T23:13:00.000Z';

type Dispatch='not-started'|'completed';
type RemoteEffect='absent'|'present';
type Response='throw'|'502'|'201';
type Visibility='hidden'|'visible';

interface World {
  id:string;
  dispatch:Dispatch;
  remote_effect:RemoteEffect;
  response:Response;
  visibility:Visibility;
}

interface Result {
  world:World;
  retry_safe_by_physics:boolean;
  adapter_outcome:string;
  durable_fingerprint:string;
  final_status:string;
  reconciliation:string;
  duplicate_retry_blocked:boolean;
}

function repository() {
  return {
    id:42,
    node_id:'R_42',
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
    created_at:CLOCK,
    updated_at:CLOCK,
  };
}

function define(kernel:OvercenterKernel) {
  kernel.initialize();
  kernel.define({
    id:'status-proof',
    packet:{effect_contract:GITHUB_COMMIT_STATUS_EFFECT},
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

function worlds():World[] {
  const out:World[]=[{
    id:'connect-fails-before-dispatch',
    dispatch:'not-started',
    remote_effect:'absent',
    response:'throw',
    visibility:'hidden',
  }];

  for (const remote_effect of ['absent','present'] as const) {
    for (const response of ['throw','502','201'] as const) {
      const visibilities:Visibility[]=remote_effect==='present'
        ? ['hidden','visible']
        : ['hidden'];
      for (const visibility of visibilities) {
        out.push({
          id:`dispatch-${remote_effect}-${response}-${visibility}`,
          dispatch:'completed',
          remote_effect,
          response,
          visibility,
        });
      }
    }
  }
  return out;
}

function message(error:unknown):string {
  return error instanceof Error ? error.message : String(error);
}

async function runWorld(world:World):Promise<Result> {
  const root=mkdtempSync(join(tmpdir(),'adapter-uncertainty-'));
  const database=join(root,'overcenter.sqlite');
  const first=new OvercenterKernel(database);
  let providerState:'missing'|'success'='missing';
  let postCalls=0;

  try {
    const run=define(first);
    const post:GithubStatusPost=async()=>{
      postCalls+=1;
      assert.equal(first.hasUnresolvedEffect(run.id),true);

      if (world.dispatch==='not-started') {
        throw new Error('CONNECT_FAILED_BEFORE_DISPATCH');
      }
      if (world.remote_effect==='present') providerState='success';
      if (world.response==='throw') throw new Error('RESPONSE_LOST_AFTER_DISPATCH');
      if (world.response==='502') return {status:502,body:'bad gateway'};
      return {status:201,body:'{}'};
    };

    let adapterOutcome='returned';
    try {
      await performGithubCommitStatusEffect(first,run,{
        token:'token',
        get:async()=>repository(),
        post,
        clock:()=>CLOCK,
      });
    } catch (error:unknown) {
      adapterOutcome=`threw:${message(error)}`;
    }

    const unresolvedBeforeRecovery=first.hasUnresolvedEffect(run.id);
    assert.equal(unresolvedBeforeRecovery,true);
    first.close();

    const visible=world.visibility==='visible' && providerState==='success';
    const get:GithubJsonGet=(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      if (path===`/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
        const statuses=visible?[status()]:[];
        return {
          state:visible?'success':'pending',
          sha:COMMIT,
          total_count:statuses.length,
          repository:repository(),
          statuses,
        };
      }
      const statusPage=`/repos/acme/widget/commits/${COMMIT}/statuses?page=1&per_page=30`;
      assert.equal(path,statusPage);
      return visible?[status()]:[];
    };

    const fresh=new OvercenterKernel(database,{
      githubToken:'token',
      observationContext:{githubGet:get,clock:()=>CLOCK},
    });
    try {
      const recovery=fresh.acquireExecution(run.id);

      const postsBeforeRetry=postCalls;
      let duplicateRetryError='';
      try {
        await performGithubCommitStatusEffect(fresh,recovery,{
          token:'token',
          get:async()=>repository(),
          post:async()=>{
            postCalls+=1;
            return {status:201,body:'{}'};
          },
          clock:()=>CLOCK,
        });
      } catch (error:unknown) {
        duplicateRetryError=message(error);
      }
      const duplicateRetryBlocked=
        duplicateRetryError==='UNRESOLVED_EFFECT'
        && postCalls===postsBeforeRetry;
      assert.equal(duplicateRetryBlocked,true);

      const interrupted=fresh.recoverInterrupted(recovery,{
        source:'adapter-uncertainty-exploration',
      });
      const settled=fresh.reconcile(recovery);
      const lifecycle=fresh.inspect()[0];
      assert.ok(lifecycle);

      const receiptSummary=fresh.receipts(run.id).map(receipt=>({
        kind:receipt.kind,
        disposition:receipt.disposition,
        verified:receipt.verified,
        certainty:receipt.observed?.mutation_certainty??null,
        observation_error:receipt.observed?.observation_error??null,
      }));
      const durableFingerprint=JSON.stringify({
        unresolved_before_recovery:unresolvedBeforeRecovery,
        duplicate_retry_blocked:duplicateRetryBlocked,
        interrupted:interrupted.disposition,
        reconciliation:settled.disposition,
        final_status:lifecycle.status,
        receipts:receiptSummary,
      });

      return {
        world,
        retry_safe_by_physics:world.dispatch==='not-started',
        adapter_outcome:adapterOutcome,
        durable_fingerprint:durableFingerprint,
        final_status:lifecycle.status,
        reconciliation:settled.disposition,
        duplicate_retry_blocked:duplicateRetryBlocked,
      };
    } finally {
      fresh.close();
    }
  } finally {
    try { first.close(); } catch {}
    rmSync(root,{recursive:true,force:true});
  }
}

const results:Result[]=[];
for (const world of worlds()) results.push(await runWorld(world));

for (const result of results) {
  assert.equal(result.duplicate_retry_blocked,true);
  if (result.final_status==='DONE') {
    assert.equal(result.world.remote_effect,'present');
    assert.equal(result.world.visibility,'visible');
  }
}

const classes=new Map<string,Result[]>();
for (const result of results) {
  const bucket=classes.get(result.durable_fingerprint)??[];
  bucket.push(result);
  classes.set(result.durable_fingerprint,bucket);
}

const retrySafetyCollisions=[...classes.values()].filter(group=>
  new Set(group.map(result=>result.retry_safe_by_physics)).size>1
);
assert.ok(
  retrySafetyCollisions.length>0,
  'expected at least one durable equivalence class to collapse distinct retry safety',
);

const preDispatch=results.find(
  result=>result.world.id==='connect-fails-before-dispatch',
);
const committedInvisible=results.find(
  result=>result.world.id==='dispatch-present-throw-hidden',
);
assert.ok(preDispatch);
assert.ok(committedInvisible);
assert.equal(preDispatch.retry_safe_by_physics,true);
assert.equal(committedInvisible.retry_safe_by_physics,false);
assert.equal(
  preDispatch.durable_fingerprint,
  committedInvisible.durable_fingerprint,
  'expected the preregistered not-dispatched vs committed-but-invisible witness',
);

const retryOnAnyThrowKilled=results.some(result=>
  result.adapter_outcome.startsWith('threw:')
  && result.world.remote_effect==='present'
);
const retryOnRecoveryRequiredKilled=results.some(result=>
  result.reconciliation==='RECOVERY_REQUIRED'
  && result.world.remote_effect==='present'
);
const trust201Killed=results.some(result=>
  result.world.response==='201'
  && result.world.remote_effect==='absent'
);
assert.equal(retryOnAnyThrowKilled,true);
assert.equal(retryOnRecoveryRequiredKilled,true);
assert.equal(trust201Killed,true);

console.log(JSON.stringify({
  experiment:'adapter-uncertainty-exploration',
  worlds:results.length,
  durable_equivalence_classes:classes.size,
  retry_safety_collisions:retrySafetyCollisions.length,
  preregistered_witness:{
    retry_safe:preDispatch.world.id,
    retry_unsafe:committedInvisible.world.id,
    shared_durable_state:JSON.parse(preDispatch.durable_fingerprint),
  },
  safety:{
    production_blind_retry_observed:false,
    false_done_observed:false,
  },
  negative_controls:{
    retry_on_any_throw:'KILLED',
    retry_on_recovery_required:'KILLED',
    trust_201_without_readback:'KILLED',
  },
},null,2));
