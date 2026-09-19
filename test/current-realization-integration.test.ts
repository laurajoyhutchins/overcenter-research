import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLAIM_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  type FactCommit,
  type HistoricalRun,
  type Receipt,
  type State,
} from '../src/facts.ts';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import {
  deriveLifecycles,
  obligationKey,
} from '../src/lifecycle.ts';
import type { Obligation, Observation } from '../src/model.ts';
import { projectCurrentLifecycles } from '../src/current-realization.ts';
import { replayProjection } from '../src/projection.ts';
import { sha256 } from '../src/digest.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-current-realization-'));
  const repo=join(root,'authority.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel,path:(name:string)=>join(root,name)};
}

const fileWork=(id:string,path:string,content='A'):Obligation=>({
  id,
  dependencies:[],
  packet:{},
  postcondition:{verifier:'file-content-equals/v1',path,content},
});

test('mutable historical DONE is current only while fresh reality still verifies',()=>{
  const f=fixture();
  try {
    const path=f.path('mutable');
    f.kernel.define({id:'x',postcondition:{verifier:'file-content-equals/v1',path,content:'A'}});
    const run=f.kernel.claim('x',f.kernel.deriveReadyWork()!.revision);
    f.kernel.beginEffect(run);
    writeFileSync(path,'A');
    assert.equal(f.kernel.resolve(run).disposition,'DONE');

    const initiallyDone=f.kernel.inspect()[0];
    assert.equal(initiallyDone.status,'DONE');
    assert.equal(initiallyDone.run_id,undefined);
    assert.equal(initiallyDone.source_run_id,run.id);

    writeFileSync(path,'B');
    const drifted=f.kernel.inspect()[0];
    assert.equal(drifted.status,'RECOVERY_REQUIRED');
    assert.equal(drifted.run_id,undefined);
    assert.equal(drifted.source_run_id,run.id);

    unlinkSync(path);
    const absent=f.kernel.inspect()[0];
    assert.equal(absent.status,'READY');
    assert.equal(absent.source_run_id,undefined);

    const retry=f.kernel.claim('x',f.kernel.deriveReadyWork()!.revision);
    const executing=f.kernel.inspect()[0];
    assert.equal(executing.status,'EXECUTING');
    assert.equal(executing.run_id,retry.id);
    assert.equal(executing.source_run_id,retry.id);

    const persisted=JSON.parse(
      execFileSync(
        'git',
        ['-C',f.repo,'show',retry.claim_commit+':claim.json'],
        {encoding:'utf8'},
      ),
    ) as Record<string,unknown>;
    assert.equal(persisted.schema,CLAIM_SCHEMA);
    const observations=persisted.current_observations as Record<string,Observation>;
    assert.equal(observations.x.mutation_certainty,'absent');
    assert.equal(observations.x.path,path);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('ambient verified state does not mint key-bound realization provenance',()=>{
  const f=fixture();
  try {
    const path=f.path('already-present');
    writeFileSync(path,'A');
    f.kernel.define({
      id:'x',
      postcondition:{verifier:'file-content-equals/v1',path,content:'A'},
    });

    const projected=f.kernel.inspect()[0];
    assert.equal(projected.status,'READY');
    assert.equal(projected.run_id,undefined);
    assert.equal(projected.source_run_id,undefined);

    const ready=f.kernel.deriveReadyWork();
    assert.ok(ready);
    const run=f.kernel.claim('x',ready.revision);
    assert.equal(f.kernel.inspect()[0].status,'EXECUTING');
    assert.equal(f.kernel.inspect()[0].run_id,run.id);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('wrong-coordinate stored observation cannot revive historical DONE',()=>{
  const work=fileWork('x','/provider/x');
  const state:State={
    obligations:{x:work},
    definition_commits:{x:'define-x'},
  };
  const base=deriveLifecycles(state,new Map(),new Map());
  const key=obligationKey(state,work,base,new Map());
  assert.ok(key);

  const run:HistoricalRun={
    id:'run-x',
    obligation_id:'x',
    claimed_revision:'define-x',
    claim_commit:'claim-x',
    obligation_key:key,
    execution_generation:1,
    execution_authority_commit:'claim-x',
    execution_capability_sha256:'0'.repeat(64),
    obligation:work,
    definition_commit:'define-x',
  };
  const receipt:Receipt={
    schema:RECEIPT_SCHEMA,
    run_id:run.id,
    obligation_id:'x',
    claimed_revision:run.claimed_revision,
    claim_commit:run.claim_commit,
    execution_generation:1,
    execution_authority_commit:run.execution_authority_commit,
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/x',
      expected_sha256:sha256('A'),
      actual_sha256:sha256('A'),
      mutation_certainty:'present',
    },
    settled_at:'2026-09-19T00:00:00.000Z',
    disposition:'DONE',
    verified:true,
    settlement_commit:'receipt-x',
  };

  const current=projectCurrentLifecycles(
    state,
    new Map([[run.id,run]]),
    new Map([[run.id,receipt]]),
    {
      x:{
        verifier:'file-content-equals/v1',
        path:'/provider/wrong',
        expected_sha256:sha256('A'),
        actual_sha256:sha256('A'),
        mutation_certainty:'present',
      },
    },
  );
  assert.equal(current.get('x')?.status,'RECOVERY_REQUIRED');
  assert.equal(current.get('x')?.sourceRun?.id,run.id);
  assert.equal(current.get('x')?.executionRun,undefined);
});

test('v4 claim replay fails closed when current observation coverage is incomplete',()=>{
  const work=fileWork('x','/provider/x');
  const define:FactCommit={
    commit:'define-x',
    parent:null,
    obligation:{
      schema:OBLIGATION_SCHEMA,
      kind:'defined',
      obligation:work,
    },
  };
  const base=replayProjection([define]);
  const key=obligationKey(
    base.state,
    work,
    base.history.lifecycles,
    base.history.receiptsByRun,
  );
  assert.ok(key);

  const claim:FactCommit={
    commit:'claim-x',
    parent:'define-x',
    claim:{
      schema:CLAIM_SCHEMA,
      run_id:'run-x',
      obligation_id:'x',
      claimed_revision:'define-x',
      obligation_key:key,
      execution_capability_sha256:'0'.repeat(64),
      current_observations:{},
    },
  };

  assert.throws(
    ()=>replayProjection([define,claim]),
    /CURRENT_OBSERVATION_SNAPSHOT_COVERAGE_MISMATCH/,
  );
});

test('historical lifecycle follows the latest same-key retry rather than an older DONE',()=>{
  const work=fileWork('x','/provider/x');
  const state:State={
    obligations:{x:work},
    definition_commits:{x:'define-x'},
  };
  const receipts=new Map<string,Receipt>();
  const initial=deriveLifecycles(state,new Map(),receipts);
  const key=obligationKey(state,work,initial,receipts);
  assert.ok(key);

  const oldRun:HistoricalRun={
    id:'run-old',
    obligation_id:'x',
    claimed_revision:'define-x',
    claim_commit:'claim-old',
    obligation_key:key,
    execution_generation:1,
    execution_authority_commit:'claim-old',
    execution_capability_sha256:'0'.repeat(64),
    obligation:work,
    definition_commit:'define-x',
  };
  const newRun:HistoricalRun={
    ...oldRun,
    id:'run-new',
    claim_commit:'claim-new',
    execution_authority_commit:'claim-new',
  };
  receipts.set(oldRun.id,{
    schema:RECEIPT_SCHEMA,
    run_id:oldRun.id,
    obligation_id:'x',
    claimed_revision:'define-x',
    claim_commit:'claim-old',
    execution_generation:1,
    execution_authority_commit:'claim-old',
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/x',
      expected_sha256:sha256('A'),
      actual_sha256:sha256('A'),
      mutation_certainty:'present',
    },
    settled_at:'2026-09-19T00:00:00.000Z',
    disposition:'DONE',
    verified:true,
    settlement_commit:'receipt-old',
  });

  const lifecycle=deriveLifecycles(
    state,
    new Map([
      [oldRun.id,oldRun],
      [newRun.id,newRun],
    ]),
    receipts,
  ).get('x');

  assert.equal(lifecycle?.status,'EXECUTING');
  assert.equal(lifecycle?.run?.id,newRun.id);
});
