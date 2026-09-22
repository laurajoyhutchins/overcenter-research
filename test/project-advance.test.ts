import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {OvercenterKernel} from '../src/kernel.ts';
import type {GithubJsonGet} from '../src/providers/github-rest.ts';
import {GITHUB_COMMIT_STATUS_EFFECT} from '../src/providers/github-status-effect.ts';
import {
  AGENT_AUTHORIZATION_POLICY,
  advanceProject,
  executeWaitingWork,
  type EffectExecutor,
} from '../src/project-advance.ts';

const COMMIT='a'.repeat(40);

function repository() {
  return {
    id:42,
    node_id:'R_42',
    full_name:'acme/widget',
    name:'widget',
    owner:{login:'acme'},
  };
}

function status(context:string) {
  return {
    id:context==='overcenter/auto' ? 7 : 8,
    node_id:context==='overcenter/auto' ? 'STATUS_7' : 'STATUS_8',
    state:'success',
    context,
    target_url:null,
    created_at:'2026-09-22T05:00:00Z',
    updated_at:'2026-09-22T05:00:01Z',
  };
}

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'project-advance-'));
  const database=join(root,'overcenter.sqlite');
  const provider=new Map<string,'success'>();

  const get:GithubJsonGet=(_token,path)=>{
    if (path==='/repos/acme/widget') return repository();
    if (path===`/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
      const statuses=[...provider.keys()].map(status);
      return {
        state:statuses.length>0?'success':'pending',
        sha:COMMIT,
        total_count:statuses.length,
        repository:repository(),
        statuses,
      };
    }
    if (path===`/repos/acme/widget/commits/${COMMIT}/statuses?page=1&per_page=30`) {
      return [...provider.keys()].map(status);
    }
    throw new Error(`unexpected GitHub path: ${path}`);
  };

  const kernel=new OvercenterKernel(database,{
    githubToken:'token',
    observationContext:{githubGet:get},
  });
  kernel.initialize();

  const execute:EffectExecutor=async(k,permit,work)=>{
    const context=String(work.postcondition.verifier==='github-commit-status/v2'
      ? work.postcondition.context
      : '');
    await k.performEffect(permit,async()=>{
      provider.set(context,'success');
    });
    return {kind:'test-provider-effect',context};
  };

  return {
    root,
    kernel,
    provider,
    execute,
    close() {
      kernel.close();
      rmSync(root,{recursive:true,force:true});
    },
  };
}

function githubPostcondition(context:string) {
  return {
    verifier:'github-commit-status/v2' as const,
    provider:'github' as const,
    repository_id:42,
    repository_full_name:'acme/widget',
    commit_sha:COMMIT,
    context,
    expected_state:'success' as const,
  };
}

test('project.advance runs deterministic work then stops before authorization-gated effect',async()=>{
  const f=fixture();
  try {
    f.kernel.define({
      id:'auto',
      packet:{effect_contract:GITHUB_COMMIT_STATUS_EFFECT},
      postcondition:githubPostcondition('overcenter/auto'),
    });
    f.kernel.define({
      id:'authorize',
      dependencies:[{kind:'control',upstream:'auto'}],
      packet:{
        effect_contract:GITHUB_COMMIT_STATUS_EFFECT,
        execution_policy:AGENT_AUTHORIZATION_POLICY,
      },
      postcondition:githubPostcondition('overcenter/authorize'),
    });

    const result=await advanceProject(f.kernel,{executeEffect:f.execute});

    assert.equal(result.outcome,'AGENT_EXECUTION_REQUIRED');
    if (result.outcome!=='AGENT_EXECUTION_REQUIRED') {
      throw new Error('expected agent execution packet');
    }
    assert.equal(result.advances,2);
    assert.equal(result.packet.work.id,'authorize');
    assert.equal(result.packet.work.status,'WAITING');
    assert.deepEqual(result.packet.allowed_actions,['work.execute']);
    assert.equal(result.packet.reason,'AGENT_AUTHORIZATION_REQUIRED');
    assert.equal(JSON.stringify(result).includes('execution_capability'),false);

    assert.deepEqual(
      f.kernel.inspect().map(work=>[work.id,work.status]),
      [['authorize','WAITING'],['auto','DONE']],
    );
    assert.equal(f.provider.get('overcenter/auto'),'success');
    assert.equal(f.provider.has('overcenter/authorize'),false);

    const waitingRun=result.packet.run_id;
    assert.deepEqual(
      f.kernel.receipts(waitingRun).map(receipt=>receipt.disposition),
      ['WAITING'],
    );

    const waitingAuthority=result.authority_revision;
    const repeated=await advanceProject(f.kernel,{executeEffect:f.execute});
    assert.equal(repeated.outcome,'AGENT_EXECUTION_REQUIRED');
    assert.equal(repeated.authority_revision,waitingAuthority);
    assert.equal(f.provider.has('overcenter/authorize'),false);
    assert.deepEqual(
      f.kernel.receipts(waitingRun).map(receipt=>receipt.disposition),
      ['WAITING'],
      'unsatisfied readback must not mutate or turn WAITING into recovery',
    );

    const executed=await executeWaitingWork(f.kernel,{executeEffect:f.execute});
    assert.equal(executed.outcome,'DONE');
    assert.equal(executed.receipt.verified,true);
    assert.equal(f.provider.get('overcenter/authorize'),'success');
    assert.equal(f.kernel.inspect().find(work=>work.id==='authorize')?.status,'DONE');

    const finished=await advanceProject(f.kernel,{executeEffect:f.execute});
    assert.equal(finished.outcome,'IDLE');
  } finally {
    f.close();
  }
});

test('project.advance settles a WAITING run after an external one-off action satisfies truth',async()=>{
  const f=fixture();
  try {
    f.kernel.define({
      id:'external',
      packet:{
        execution_policy:AGENT_AUTHORIZATION_POLICY,
        effect_contract:'agent-one-off/v1',
      },
      postcondition:githubPostcondition('overcenter/external'),
    });

    const waiting=await advanceProject(f.kernel,{executeEffect:f.execute});
    assert.equal(waiting.outcome,'AGENT_EXECUTION_REQUIRED');
    if (waiting.outcome!=='AGENT_EXECUTION_REQUIRED') {
      throw new Error('expected waiting packet');
    }
    assert.deepEqual(waiting.packet.allowed_actions,[]);
    assert.equal(waiting.packet.reason,'NO_DETERMINISTIC_EFFECT_EXECUTOR');

    f.provider.set('overcenter/external','success');

    const settled=await advanceProject(f.kernel,{executeEffect:f.execute});
    assert.equal(settled.outcome,'IDLE');
    assert.equal(f.kernel.inspect()[0].status,'DONE');
    assert.deepEqual(
      f.kernel.receipts(waiting.packet.run_id).map(receipt=>receipt.disposition),
      ['WAITING','DONE'],
    );
  } finally {
    f.close();
  }
});

test('work.execute rejects WAITING work that did not pre-authorize a supported effect',async()=>{
  const f=fixture();
  try {
    f.kernel.define({
      id:'unsupported',
      packet:{
        execution_policy:AGENT_AUTHORIZATION_POLICY,
        effect_contract:'unsupported/v1',
      },
      postcondition:githubPostcondition('overcenter/unsupported'),
    });
    const waiting=await advanceProject(f.kernel,{executeEffect:f.execute});
    assert.equal(waiting.outcome,'AGENT_EXECUTION_REQUIRED');

    await assert.rejects(
      executeWaitingWork(f.kernel,{executeEffect:f.execute}),
      /WORK_EXECUTE_EFFECT_UNSUPPORTED/,
    );
    assert.equal(f.kernel.inspect()[0].status,'WAITING');
  } finally {
    f.close();
  }
});

test('work.execute preserves WAITING when deterministic execution fails before reservation',async()=>{
  const f=fixture();
  try {
    f.kernel.define({
      id:'retryable-authorization',
      packet:{
        execution_policy:AGENT_AUTHORIZATION_POLICY,
        effect_contract:GITHUB_COMMIT_STATUS_EFFECT,
      },
      postcondition:githubPostcondition('overcenter/retryable'),
    });
    const waiting=await advanceProject(f.kernel,{executeEffect:f.execute});
    assert.equal(waiting.outcome,'AGENT_EXECUTION_REQUIRED');

    const failed=await executeWaitingWork(f.kernel,{
      executeEffect:async()=>{throw new Error('provider identity unavailable');},
    });
    assert.equal(failed.outcome,'AGENT_EXECUTION_REQUIRED');
    assert.match(failed.reason,/DETERMINISTIC_EFFECT_FAILED_BEFORE_RESERVATION/);
    assert.equal(f.kernel.inspect()[0].status,'WAITING');
    assert.equal(f.kernel.hasUnresolvedEffect(f.kernel.inspect()[0].run_id!),false);
  } finally {
    f.close();
  }
});
