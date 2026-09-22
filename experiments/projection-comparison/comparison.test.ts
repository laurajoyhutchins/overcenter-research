import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  HistoricalRun,
  Receipt,
  State,
} from '../../src/facts.ts';
import { RECEIPT_SCHEMA } from '../../src/facts.ts';
import type {
  Dependency,
  Obligation,
} from '../../src/model.ts';
import { deriveProjectProjection } from '../../src/projector.ts';
import { MutableStatusMachine } from './mutable-status.ts';
import type {
  ProjectionInput,
  ProjectionReceipt,
  ProjectionRun,
  ProjectStatus,
  StatusMap,
} from './model.ts';
import { sortedStatuses } from './model.ts';
import { projectWithSql } from './sql-projector.ts';

const PROGRAM=join(
  process.cwd(),
  'experiments',
  'projection-comparison',
  'project.dl',
);

const sha256=(value:string)=>
  createHash('sha256').update(value).digest('hex');

interface SequencedRun {
  record:HistoricalRun;
  sequence:number;
}

interface SequencedReceipt {
  record:Receipt;
  sequence:number;
}

interface History {
  runs:SequencedRun[];
  receipts:SequencedReceipt[];
}

function obligation(
  id:string,
  version:string,
  dependencies:Dependency[]=[],
):Obligation {
  return {
    id,
    dependencies,
    packet:{version},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:`/provider/${id}`,
      content:`${id}:${version}`,
    },
  };
}

function state(
  obligations:Obligation[],
  revision:string,
):State {
  return {
    obligations:Object.fromEntries(
      obligations.map(work=>[work.id,structuredClone(work)]),
    ),
    definition_ids:Object.fromEntries(
      obligations.map(work=>[work.id,`${revision}:${work.id}`]),
    ),
  };
}

function latestReceipts(history:History):Map<string,Receipt> {
  const latest=new Map<string,SequencedReceipt>();
  for (const receipt of history.receipts) {
    const existing=latest.get(receipt.record.run_id);
    if (!existing || receipt.sequence>existing.sequence) {
      latest.set(receipt.record.run_id,receipt);
    }
  }
  return new Map(
    [...latest].map(([runId,receipt])=>[runId,receipt.record]),
  );
}

function runMap(history:History):Map<string,HistoricalRun> {
  return new Map(history.runs.map(run=>[run.record.id,run.record]));
}

function projectTs(
  current:State,
  history:History,
  admissibleRuns:Set<string>,
  revision:string,
) {
  const runs=runMap(history);
  const currentRealizationJudgments=new Map(
    [...runs.keys()].map(runId=>[
      runId,
      admissibleRuns.has(runId)
        ? {
            state:'admissible' as const,
            reason:'CURRENT_POSTCONDITION_VERIFIED' as const,
          }
        : {
            state:'rejected' as const,
            reason:'CURRENT_POSTCONDITION_NOT_VERIFIED' as const,
          },
    ]),
  );
  return deriveProjectProjection({
    state:current,
    runs,
    receiptsByRun:latestReceipts(history),
    revision,
    currentRealizationJudgments,
  });
}

function normalizedInput(
  current:State,
  history:History,
  admissibleRuns:Set<string>,
  revision:string,
):{
  input:ProjectionInput;
  statuses:StatusMap;
} {
  const projected=projectTs(current,history,admissibleRuns,revision);
  const input:ProjectionInput={
    obligations:Object.keys(current.obligations).sort(),
    dependencies:Object.values(current.obligations).flatMap(work=>
      work.dependencies.map(edge=>({
        downstream:work.id,
        upstream:edge.upstream,
      })),
    ),
    semanticKeys:new Map(projected.semanticKeys),
    runs:history.runs.map(({record,sequence}):ProjectionRun=>({
      id:record.id,
      obligation:record.obligation_id,
      semanticKey:record.obligation_key,
      sequence,
    })),
    receipts:history.receipts.map(({record,sequence}):ProjectionReceipt=>({
      run:record.run_id,
      disposition:record.disposition,
      sequence,
    })),
    admissibleRuns:new Set(admissibleRuns),
  };
  return {
    input,
    statuses:new Map(
      projected.work.map(work=>[work.id,work.status as ProjectStatus]),
    ),
  };
}

function writeFacts(
  path:string,
  rows:Array<Array<string|number>>,
):void {
  writeFileSync(
    path,
    rows.map(row=>row.join('\t')).join('\n')+(rows.length?'\n':''),
  );
}

function projectWithDatalog(input:ProjectionInput):StatusMap {
  const root=mkdtempSync(join(tmpdir(),'overcenter-projection-comparison-'));
  const facts=join(root,'facts');
  const output=join(root,'output');
  mkdirSync(facts);
  mkdirSync(output);

  try {
    writeFacts(
      join(facts,'obligation.facts'),
      input.obligations.map(id=>[id]),
    );
    writeFacts(
      join(facts,'dependency.facts'),
      input.dependencies.map(edge=>[edge.downstream,edge.upstream]),
    );
    writeFacts(
      join(facts,'semantic_key.facts'),
      [...input.semanticKeys].flatMap(([id,key])=>key?[[id,key]]:[]),
    );
    writeFacts(
      join(facts,'run.facts'),
      input.runs.map(run=>[
        run.id,
        run.obligation,
        run.semanticKey,
        run.sequence,
      ]),
    );
    writeFacts(
      join(facts,'receipt.facts'),
      input.receipts.map(receipt=>[
        receipt.run,
        receipt.disposition,
        receipt.sequence,
      ]),
    );
    writeFacts(
      join(facts,'admissible_run.facts'),
      [...input.admissibleRuns].map(runId=>[runId]),
    );

    execFileSync(
      'souffle',
      ['-F',facts,'-D',output,PROGRAM],
      {stdio:'pipe'},
    );

    const text=readFileSync(join(output,'project_status.csv'),'utf8').trim();
    const rows=text ? text.split(/\r?\n/) : [];
    return new Map(rows.map(row=>{
      const [id,status]=row.split('\t');
      return [id,status as ProjectStatus];
    }));
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

function assertDerivedImplementationsAgree(
  label:string,
  current:State,
  history:History,
  admissibleRuns:Set<string>,
  revision:string,
  expected:Array<[string,ProjectStatus]>,
):ProjectionInput {
  const {input,statuses}=normalizedInput(
    current,
    history,
    admissibleRuns,
    revision,
  );
  const sql=projectWithSql(input);
  const datalog=projectWithDatalog(input);

  assert.deepEqual(sortedStatuses(statuses),expected,`${label}: TypeScript`);
  assert.deepEqual(sortedStatuses(sql),expected,`${label}: SQL`);
  assert.deepEqual(sortedStatuses(datalog),expected,`${label}: Datalog`);
  return input;
}

function historicalRun(
  id:string,
  work:Obligation,
  key:string,
  sequence:number,
):SequencedRun {
  return {
    sequence,
    record:{
      id,
      obligation_id:work.id,
      claimed_revision:`revision-${sequence}`,
      claim_commit:`claim-${sequence}`,
      obligation_key:key,
      execution_generation:1,
      execution_authority_commit:`claim-${sequence}`,
      execution_capability_sha256:sha256(`permit-${sequence}`),
      obligation:structuredClone(work),
      definition_commit:`definition-${sequence}`,
    },
  };
}

function receipt(
  run:HistoricalRun,
  disposition:Receipt['disposition'],
  sequence:number,
):SequencedReceipt {
  return {
    sequence,
    record:{
      schema:RECEIPT_SCHEMA,
      run_id:run.id,
      obligation_id:run.obligation_id,
      claimed_revision:run.claimed_revision,
      claim_commit:run.claim_commit,
      execution_generation:run.execution_generation,
      execution_authority_commit:run.execution_authority_commit,
      kind:disposition==='WAITING'
        ? 'judgment-required'
        : disposition==='RECOVERY_REQUIRED'
          ? 'execution-terminated'
          : 'observation',
      observed:null,
      settled_at:`sequence:${sequence}`,
      disposition,
      verified:disposition==='DONE',
      settlement_commit:`receipt-${sequence}`,
    },
  };
}

test('derived implementations agree while mutable lifecycle requires explicit semantic invalidation',()=>{
  const aV1=obligation('a','v1');
  const b=obligation('b','v1',[{kind:'control',upstream:'a'}]);
  const stateV1=state([aV1,b],'v1');
  const empty:History={runs:[],receipts:[]};
  const noAdmissible=new Set<string>();

  const initial=assertDerivedImplementationsAgree(
    'initial graph',
    stateV1,
    empty,
    noAdmissible,
    'v1',
    [['a','READY'],['b','BLOCKED']],
  );

  const keyA1=initial.semanticKeys.get('a');
  assert.ok(keyA1);
  const runA1=historicalRun('run-a1',aV1,keyA1,10);
  const historyA1:History={
    runs:[runA1],
    receipts:[receipt(runA1.record,'DONE',20)],
  };
  const admissibleA1=new Set(['run-a1']);

  assertDerivedImplementationsAgree(
    'first realization',
    stateV1,
    historyA1,
    admissibleA1,
    'v1-done',
    [['a','DONE'],['b','READY']],
  );

  const mutable=new MutableStatusMachine(
    ['a','b'],
    [{downstream:'b',upstream:'a'}],
  );
  try {
    mutable.claim('a');
    mutable.settle('a','DONE');
    assert.deepEqual(
      sortedStatuses(mutable.snapshot()),
      [['a','DONE'],['b','READY']],
    );

    const aV2=obligation('a','v2');
    const stateV2=state([aV2,b],'v2');

    const changed=assertDerivedImplementationsAgree(
      'material semantic change',
      stateV2,
      historyA1,
      admissibleA1,
      'v2',
      [['a','READY'],['b','BLOCKED']],
    );

    // The mutable status implementation has no query whose result changes just
    // because meaning changed. Its old answer remains plausible and wrong.
    assert.deepEqual(
      sortedStatuses(mutable.snapshot()),
      [['a','DONE'],['b','READY']],
    );

    const writesBeforeRepair=mutable.statusWrites;
    mutable.invalidateMeaning('a');
    const semanticRepairWrites=mutable.statusWrites-writesBeforeRepair;
    assert.equal(semanticRepairWrites,2);
    assert.deepEqual(
      sortedStatuses(mutable.snapshot()),
      [['a','READY'],['b','BLOCKED']],
    );

    const keyA2=changed.semanticKeys.get('a');
    assert.ok(keyA2);
    const runA2=historicalRun('run-a2',aV2,keyA2,30);
    const executing:History={
      runs:[runA1,runA2],
      receipts:historyA1.receipts,
    };

    assertDerivedImplementationsAgree(
      'second run executing',
      stateV2,
      executing,
      admissibleA1,
      'v2-executing',
      [['a','EXECUTING'],['b','BLOCKED']],
    );
    mutable.claim('a');

    const recovery:History={
      runs:executing.runs,
      receipts:[
        ...executing.receipts,
        receipt(runA2.record,'RECOVERY_REQUIRED',40),
      ],
    };
    assertDerivedImplementationsAgree(
      'recovery required',
      stateV2,
      recovery,
      admissibleA1,
      'v2-recovery',
      [['a','RECOVERY_REQUIRED'],['b','BLOCKED']],
    );
    mutable.settle('a','RECOVERY_REQUIRED');

    const settled:History={
      runs:executing.runs,
      receipts:[
        ...executing.receipts,
        receipt(runA2.record,'RECOVERY_REQUIRED',40),
        receipt(runA2.record,'DONE',50),
      ],
    };
    const admissibleA2=new Set(['run-a1','run-a2']);
    assertDerivedImplementationsAgree(
      'recovered realization',
      stateV2,
      settled,
      admissibleA2,
      'v2-done',
      [['a','DONE'],['b','READY']],
    );
    mutable.settle('a','DONE');

    const withdrawn=new Set(['run-a1']);
    assertDerivedImplementationsAgree(
      'current realization no longer admissible',
      stateV2,
      settled,
      withdrawn,
      'v2-drifted',
      [['a','READY'],['b','BLOCKED']],
    );

    // Again the historical status row has no way to become false without a
    // correctness-sensitive repair mutation.
    assert.deepEqual(
      sortedStatuses(mutable.snapshot()),
      [['a','DONE'],['b','READY']],
    );

    const writesBeforeDriftRepair=mutable.statusWrites;
    mutable.invalidateMeaning('a');
    const driftRepairWrites=mutable.statusWrites-writesBeforeDriftRepair;
    assert.equal(driftRepairWrites,2);

    // Projection loss is harmless for the derived implementations: the same
    // input reconstructs the same answer in fresh TypeScript/SQL/Datalog
    // processes. For the authoritative mutable lifecycle, erasure destroys the
    // answer until another mechanism repairs it.
    assert.deepEqual(
      sortedStatuses(projectWithSql(changed)),
      [['a','READY'],['b','BLOCKED']],
    );
    mutable.eraseLifecycle();
    assert.throws(
      ()=>mutable.snapshot(),
      /MATERIALIZED_LIFECYCLE_MISSING/,
    );
  } finally {
    mutable.close();
  }
});

test('terminal READY and WAITING semantics agree across all derived implementations',()=>{
  const x=obligation('x','v1');
  const current=state([x],'single');
  const base=normalizedInput(
    current,
    {runs:[],receipts:[]},
    new Set(),
    'single',
  );
  const key=base.input.semanticKeys.get('x');
  assert.ok(key);

  const runX=historicalRun('run-x',x,key,10);
  const waiting:History={
    runs:[runX],
    receipts:[receipt(runX.record,'WAITING',20)],
  };
  assertDerivedImplementationsAgree(
    'waiting',
    current,
    waiting,
    new Set(),
    'waiting',
    [['x','WAITING']],
  );

  const ready:History={
    runs:[runX],
    receipts:[receipt(runX.record,'READY',30)],
  };
  assertDerivedImplementationsAgree(
    'accepted absence',
    current,
    ready,
    new Set(),
    'ready',
    [['x','READY']],
  );
});

test('derived projectors reconstruct a fan-out graph without status repair',()=>{
  const root=obligation('root','v1');
  const leaves=Array.from({length:20},(_,index)=>
    obligation(
      `leaf-${String(index).padStart(2,'0')}`,
      'v1',
      [{kind:'control',upstream:'root'}],
    ),
  );
  const current=state([root,...leaves],'fanout');
  const initial=normalizedInput(
    current,
    {runs:[],receipts:[]},
    new Set(),
    'fanout',
  );
  const rootKey=initial.input.semanticKeys.get('root');
  assert.ok(rootKey);

  const runRoot=historicalRun('run-root',root,rootKey,10);
  const history:History={
    runs:[runRoot],
    receipts:[receipt(runRoot.record,'DONE',20)],
  };
  const admissible=new Set(['run-root']);
  const {input,statuses}=normalizedInput(
    current,
    history,
    admissible,
    'fanout-done',
  );

  const expected:Array<[string,ProjectStatus]>=[
    ['root','DONE'],
    ...leaves
      .map(leaf=>[leaf.id,'READY'] as [string,ProjectStatus])
      .sort(([a],[b])=>a.localeCompare(b)),
  ].sort(([a],[b])=>a.localeCompare(b));

  assert.deepEqual(sortedStatuses(statuses),expected);
  assert.deepEqual(sortedStatuses(projectWithSql(input)),expected);
  assert.deepEqual(sortedStatuses(projectWithDatalog(input)),expected);

  const mutable=new MutableStatusMachine(
    ['root',...leaves.map(leaf=>leaf.id)],
    leaves.map(leaf=>({downstream:leaf.id,upstream:'root'})),
  );
  try {
    mutable.claim('root');
    mutable.settle('root','DONE');
    assert.deepEqual(sortedStatuses(mutable.snapshot()),expected);

    const before=mutable.statusWrites;
    mutable.invalidateMeaning('root');
    const repairWrites=mutable.statusWrites-before;

    // One semantic change fans out into one root repair plus one durable status
    // repair for every dependent materialization.
    assert.equal(repairWrites,1+leaves.length);

    const expectedInvalidated:Array<[string,ProjectStatus]>=[
      ['root','READY'],
      ...leaves
        .map(leaf=>[leaf.id,'BLOCKED'] as [string,ProjectStatus])
        .sort(([a],[b])=>a.localeCompare(b)),
    ].sort(([a],[b])=>a.localeCompare(b));

    assert.deepEqual(
      sortedStatuses(mutable.snapshot()),
      expectedInvalidated,
    );
  } finally {
    mutable.close();
  }
});
