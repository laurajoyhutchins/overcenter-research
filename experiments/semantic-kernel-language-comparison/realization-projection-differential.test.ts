import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256 } from '../../src/digest.ts';
import { localFileEnoentEvidence, type AbsenceEvidenceCertificate } from '../../src/evidence.ts';
import { RECEIPT_SCHEMA, type Receipt, type ReceiptFact, type State } from '../../src/facts.ts';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { obligationKey, type Lifecycle } from '../../src/lifecycle.ts';
import type { Dependency, Obligation, Observation, Postcondition } from '../../src/model.ts';
import { observePostcondition } from '../../src/observation.ts';
import { projectReceipt } from '../../src/projection.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterRealizationProjection';
const semanticKernel='./experiments/lean-kernel/.lake/build/bin/overcenterSemanticIdentity';
const verifierRevision='file-content-equals/v1@semantics-1';

type RunStatus='EXECUTING'|'WAITING'|'RECOVERY_REQUIRED'|'DONE'|'READY';

interface RunProjection {
  run_id:string;
  obligation_key:string;
  status:RunStatus;
}

interface ProjectionRequest {
  postcondition:Postcondition;
  currentKey:string|null;
  runs:RunProjection[];
  freshObservation:Observation|null;
}

interface ProjectionResult {
  lifecycle:'UNREALIZED'|'EXECUTING'|'WAITING'|'RECOVERY_REQUIRED'|'DONE';
  sourceRunId:string|null;
}

function data(value:unknown):Record<string,unknown> {
  assert.ok(value && typeof value==='object' && !Array.isArray(value));
  return value as Record<string,unknown>;
}

function leanAbsence(evidence:AbsenceEvidenceCertificate|undefined):unknown {
  if (!evidence) return null;
  if (evidence.kind!=='local-file-enoent/v1') {
    throw new Error('REALIZATION_TEST_ONLY_SUPPORTS_LOCAL_ABSENCE');
  }
  const subject=data(evidence.subject);
  const scope=data(evidence.scope);
  const coordinate=data(scope.coordinate);
  const completeness=data(evidence.completeness);
  const provenance=data(evidence.provenance);
  return {
    kind:evidence.kind,
    subject_coordinate:subject.path,
    scope_coordinate:coordinate.path,
    snapshot_is_null:evidence.snapshot===null,
    completeness_kind:completeness.kind,
    completeness_result:completeness.result,
    provenance_adapter:provenance.adapter,
    provenance_operation:provenance.operation,
    provenance_error_code:provenance.error_code,
  };
}

function leanPostcondition(postcondition:Postcondition):unknown {
  if (postcondition.verifier!=='file-content-equals/v1') {
    throw new Error('REALIZATION_TEST_ONLY_SUPPORTS_FILE_POSTCONDITION');
  }
  return {
    family:'file-content',
    verifier_revision:verifierRevision,
    coordinate:postcondition.path,
    expected:sha256(postcondition.content),
  };
}

function leanObservation(observation:Observation|null):unknown {
  if (!observation) return null;
  if (observation.verifier!=='file-content-equals/v1') {
    throw new Error('REALIZATION_TEST_ONLY_SUPPORTS_FILE_OBSERVATION');
  }
  return {
    family:'file-content',
    verifier_revision:verifierRevision,
    coordinate:observation.path,
    certainty:observation.mutation_certainty,
    actual:observation.actual_sha256??null,
    absence:leanAbsence(observation.absence_evidence),
  };
}

function leanResponse(input:ProjectionRequest):{
  schema:string;
  lifecycle:ProjectionResult['lifecycle'];
  source_run_id:string|null;
  execution_run_id:string|null;
} {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify({
      command:'realization-project',
      postcondition:leanPostcondition(input.postcondition),
      current_key:input.currentKey,
      runs:input.runs,
      fresh_observation:leanObservation(input.freshObservation),
    }),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  const response=JSON.parse(stdout) as {
    schema:string;
    lifecycle:ProjectionResult['lifecycle'];
    source_run_id:string|null;
    execution_run_id:string|null;
  };
  assert.equal(response.schema,'overcenter-lean-realization-projection/v1');
  return response;
}

function leanProject(input:ProjectionRequest):ProjectionResult {
  const response=leanResponse(input);
  return {lifecycle:response.lifecycle,sourceRunId:response.source_run_id};
}

function freshDisposition(
  postcondition:Postcondition,
  observation:Observation,
):'DONE'|'READY'|'RECOVERY_REQUIRED' {
  const work:Obligation={
    id:'projection-control',
    dependencies:[],
    packet:{},
    postcondition,
  };
  const fact:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'fresh-observation',
    obligation_id:work.id,
    claimed_revision:'revision',
    claim_commit:'claim',
    execution_generation:1,
    execution_authority_commit:'claim',
    kind:'observation',
    observed:observation,
    settled_at:'2026-09-19T00:00:00.000Z',
  };
  try {
    return projectReceipt(fact,work).disposition as 'DONE'|'READY'|'RECOVERY_REQUIRED';
  } catch (error:unknown) {
    if (
      error instanceof Error
      && error.message==='OBSERVATION_COORDINATE_MISMATCH'
    ) {
      return 'RECOVERY_REQUIRED';
    }
    throw error;
  }
}

function correctedTsProject(input:ProjectionRequest):ProjectionResult {
  const latestNonterminal=[...input.runs].reverse().find(run=>
    run.status==='EXECUTING'
    || run.status==='WAITING'
    || run.status==='RECOVERY_REQUIRED',
  );

  if (latestNonterminal) {
    if (!input.currentKey || latestNonterminal.obligation_key!==input.currentKey) {
      return {lifecycle:'RECOVERY_REQUIRED',sourceRunId:latestNonterminal.run_id};
    }
    return {lifecycle:latestNonterminal.status,sourceRunId:latestNonterminal.run_id};
  }

  if (!input.currentKey) return {lifecycle:'UNREALIZED',sourceRunId:null};

  const historicalDone=[...input.runs].reverse().find(run=>
    run.status==='DONE' && run.obligation_key===input.currentKey,
  );

  if (historicalDone) {
    if (!input.freshObservation) {
      return {lifecycle:'RECOVERY_REQUIRED',sourceRunId:historicalDone.run_id};
    }
    const disposition=freshDisposition(input.postcondition,input.freshObservation);
    if (disposition==='DONE') {
      return {lifecycle:'DONE',sourceRunId:historicalDone.run_id};
    }
    if (disposition==='READY') return {lifecycle:'UNREALIZED',sourceRunId:null};
    return {lifecycle:'RECOVERY_REQUIRED',sourceRunId:historicalDone.run_id};
  }

  // A bare observation is not realization provenance for the current
  // semantic key. It may revalidate a matching key-bound realization above,
  // but it cannot mint one here.
  return {lifecycle:'UNREALIZED',sourceRunId:null};
}

function filePostcondition(path='/provider/a'):Extract<
  Postcondition,
  {verifier:'file-content-equals/v1'}
> {
  return {verifier:'file-content-equals/v1',path,content:'A'};
}

function present(path='/provider/a',content='A'):Observation {
  return {
    verifier:'file-content-equals/v1',
    path,
    expected_sha256:sha256('A'),
    actual_sha256:sha256(content),
    mutation_certainty:'present',
  };
}

function uncertain(path='/provider/a'):Observation {
  return {
    verifier:'file-content-equals/v1',
    path,
    expected_sha256:sha256('A'),
    mutation_certainty:'uncertain',
    observation_error:'indeterminate',
  };
}

function absent(path='/provider/a'):Observation {
  return {
    verifier:'file-content-equals/v1',
    path,
    expected_sha256:sha256('A'),
    mutation_certainty:'absent',
    absence_evidence:localFileEnoentEvidence(path),
  };
}

const done=(run_id='run-done',key='key-a'):RunProjection=>({
  run_id,
  obligation_key:key,
  status:'DONE',
});

test('Lean realization projection agrees with corrected TypeScript control on hostile cases',()=>{
  const postcondition=filePostcondition();
  const cases:Array<{name:string;input:ProjectionRequest;expected:ProjectionResult}>=[
    {
      name:'bare fresh observation is not a key-bound realization',
      input:{postcondition,currentKey:'key-a',runs:[],freshObservation:present()},
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
    {
      name:'mutable historical DONE without fresh evidence',
      input:{postcondition,currentKey:'key-a',runs:[done()],freshObservation:null},
      expected:{lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-done'},
    },
    {
      name:'mutable historical DONE freshly verified',
      input:{postcondition,currentKey:'key-a',runs:[done()],freshObservation:present()},
      expected:{lifecycle:'DONE',sourceRunId:'run-done'},
    },
    {
      name:'mutable historical DONE with uncertain reality',
      input:{postcondition,currentKey:'key-a',runs:[done()],freshObservation:uncertain()},
      expected:{lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-done'},
    },
    {
      name:'mutable historical DONE authoritatively absent',
      input:{postcondition,currentKey:'key-a',runs:[done()],freshObservation:absent()},
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
    {
      name:'mutable historical DONE wrong coordinate',
      input:{postcondition,currentKey:'key-a',runs:[done()],freshObservation:present('/provider/wrong')},
      expected:{lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-done'},
    },
    {
      name:'stale semantic key cannot reuse historical DONE',
      input:{postcondition,currentKey:'key-b',runs:[done('run-old','key-a')],freshObservation:null},
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
    {
      name:'matching current execution',
      input:{
        postcondition,
        currentKey:'key-a',
        runs:[{run_id:'run-active',obligation_key:'key-a',status:'EXECUTING'}],
        freshObservation:present(),
      },
      expected:{lifecycle:'EXECUTING',sourceRunId:'run-active'},
    },
    {
      name:'matching WAITING execution',
      input:{
        postcondition,
        currentKey:'key-a',
        runs:[{run_id:'run-active',obligation_key:'key-a',status:'WAITING'}],
        freshObservation:null,
      },
      expected:{lifecycle:'WAITING',sourceRunId:'run-active'},
    },
    {
      name:'matching recovery execution',
      input:{
        postcondition,
        currentKey:'key-a',
        runs:[{run_id:'run-active',obligation_key:'key-a',status:'RECOVERY_REQUIRED'}],
        freshObservation:null,
      },
      expected:{lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-active'},
    },
    {
      name:'terminal READY remains unrealized',
      input:{
        postcondition,
        currentKey:'key-a',
        runs:[{run_id:'run-ready',obligation_key:'key-a',status:'READY'}],
        freshObservation:null,
      },
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
    {
      name:'stale-key active execution fails closed',
      input:{
        postcondition,
        currentKey:'key-b',
        runs:[{run_id:'run-active',obligation_key:'key-a',status:'EXECUTING'}],
        freshObservation:present(),
      },
      expected:{lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-active'},
    },
    {
      name:'unresolved current key cannot erase active execution',
      input:{
        postcondition,
        currentKey:null,
        runs:[{run_id:'run-active',obligation_key:'key-a',status:'WAITING'}],
        freshObservation:null,
      },
      expected:{lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-active'},
    },
    {
      name:'unresolved key with terminal history remains unrealized',
      input:{postcondition,currentKey:null,runs:[done()],freshObservation:present()},
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
    {
      name:'latest matching historical realization selected deterministically',
      input:{postcondition,currentKey:'key-a',runs:[done('run-old'),done('run-new')],freshObservation:present()},
      expected:{lifecycle:'DONE',sourceRunId:'run-new'},
    },
    {
      name:'fresh output cannot launder a stale semantic key',
      input:{postcondition,currentKey:'key-b',runs:[done('run-old','key-a')],freshObservation:present()},
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
    {
      name:'uncertainty with no known prior realization remains unrealized',
      input:{postcondition,currentKey:'key-a',runs:[],freshObservation:uncertain()},
      expected:{lifecycle:'UNREALIZED',sourceRunId:null},
    },
  ];

  for (const candidate of cases) {
    const lean=leanProject(candidate.input);
    const typescript=correctedTsProject(candidate.input);
    assert.deepEqual(typescript,candidate.expected,candidate.name+': TypeScript control');
    assert.deepEqual(lean,candidate.expected,candidate.name+': Lean');
    assert.deepEqual(lean,typescript,candidate.name+': differential');
    assert.deepEqual(leanProject(candidate.input),lean,candidate.name+': deterministic replay');
  }
});

test('realization provenance is not confused with live execution authority',()=>{
  const postcondition=filePostcondition();

  const historical=leanResponse({
    postcondition,
    currentKey:'key-a',
    runs:[done()],
    freshObservation:uncertain(),
  });
  assert.equal(historical.lifecycle,'RECOVERY_REQUIRED');
  assert.equal(historical.source_run_id,'run-done');
  assert.equal(historical.execution_run_id,null);

  const active=leanResponse({
    postcondition,
    currentKey:'key-b',
    runs:[{
      run_id:'run-active',
      obligation_key:'key-a',
      status:'EXECUTING',
    }],
    freshObservation:present(),
  });
  assert.equal(active.lifecycle,'RECOVERY_REQUIRED');
  assert.equal(active.source_run_id,'run-active');
  assert.equal(active.execution_run_id,'run-active');
});

test('current external reality deliberately changes current projection',()=>{
  const base:Omit<ProjectionRequest,'freshObservation'>={
    postcondition:filePostcondition(),
    currentKey:'key-a',
    runs:[done()],
  };

  assert.deepEqual(
    leanProject({...base,freshObservation:present()}),
    {lifecycle:'DONE',sourceRunId:'run-done'},
  );
  assert.deepEqual(
    leanProject({...base,freshObservation:absent()}),
    {lifecycle:'UNREALIZED',sourceRunId:null},
  );
  assert.deepEqual(
    leanProject({...base,freshObservation:present('/provider/a','B')}),
    {lifecycle:'RECOVERY_REQUIRED',sourceRunId:'run-done'},
  );
});

test('existing runtime gap is historical replay, not corrected current projection',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-realization-projection-'));
  const repo=join(root,'authority.git');
  const external=join(root,'mutable.txt');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});

  try {
    const owner=new GitOvercenterKernel(repo);
    owner.initialize();
    owner.define({
      id:'mutable-file',
      postcondition:{verifier:'file-content-equals/v1',path:external,content:'A'},
    });

    const ready=owner.deriveReadyWork();
    assert.ok(ready);
    const permit=owner.claim(ready.id,ready.revision);
    owner.beginEffect(permit);
    writeFileSync(external,'A');
    assert.equal(owner.resolve(permit).disposition,'DONE');

    writeFileSync(external,'B');

    const historical=new GitOvercenterKernel(repo);
    assert.equal(
      historical.inspect().find(work=>work.id==='mutable-file')?.status,
      'DONE',
      'existing runtime intentionally remains the known historical-only gap',
    );

    const observation=observePostcondition(
      filePostcondition(external),
      {githubToken:null},
    );
    const corrected:ProjectionRequest={
      postcondition:filePostcondition(external),
      currentKey:permit.obligation_key,
      runs:[{
        run_id:permit.id,
        obligation_key:permit.obligation_key,
        status:'DONE',
      }],
      freshObservation:observation,
    };
    assert.deepEqual(
      correctedTsProject(corrected),
      {lifecycle:'RECOVERY_REQUIRED',sourceRunId:permit.id},
    );
    assert.deepEqual(
      leanProject(corrected),
      {lifecycle:'RECOVERY_REQUIRED',sourceRunId:permit.id},
    );

    unlinkSync(external);
    const absentNow=observePostcondition(filePostcondition(external),{githubToken:null});
    assert.deepEqual(
      leanProject({...corrected,freshObservation:absentNow}),
      {lifecycle:'UNREALIZED',sourceRunId:null},
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

function stateOf(...obligations:Obligation[]):State {
  return {
    obligations:Object.fromEntries(obligations.map(item=>[item.id,item])),
    definition_commits:Object.fromEntries(
      obligations.map(item=>[item.id,'define:'+item.id]),
    ),
  };
}

const semanticOutput=(upstream:string):Dependency=>({
  kind:'semantic',
  upstream,
  consumes:{kind:'output',selector:'verified-content'},
});

const semanticReceipt=(upstream:string):Dependency=>({
  kind:'semantic',
  upstream,
  consumes:{kind:'evidence',selector:'settlement-receipt'},
});

test('key-bound runless DONE can feed verified-content identity but cannot invent a settlement receipt',()=>{
  const upstream:Obligation={
    id:'upstream',
    dependencies:[],
    packet:{},
    postcondition:filePostcondition('/provider/upstream'),
  };
  const outputTarget:Obligation={
    id:'output-target',
    dependencies:[semanticOutput('upstream')],
    packet:{},
    postcondition:filePostcondition('/provider/output-target'),
  };
  const receiptTarget:Obligation={
    id:'receipt-target',
    dependencies:[semanticReceipt('upstream')],
    packet:{},
    postcondition:filePostcondition('/provider/receipt-target'),
  };

  const outputState=stateOf(upstream,outputTarget);
  const receiptState=stateOf(upstream,receiptTarget);
  const outputLifecycles=new Map<string,Lifecycle>([
    ['upstream',{status:'DONE'}],
    ['output-target',{status:'UNREALIZED'}],
  ]);
  const receiptLifecycles=new Map<string,Lifecycle>([
    ['upstream',{status:'DONE'}],
    ['receipt-target',{status:'UNREALIZED'}],
  ]);
  const receipts=new Map<string,Receipt>();

  assert.ok(
    obligationKey(outputState,outputTarget,outputLifecycles,receipts),
    'verified-content identity must not require a producer run',
  );
  assert.equal(
    obligationKey(receiptState,receiptTarget,receiptLifecycles,receipts),
    null,
    'settlement-receipt identity still requires durable settlement provenance',
  );

  const requestBase={
    current_revision:'r1',
    expected_revision:'r1',
    target_id:'target',
    obligations:[
      {
        id:'upstream',
        dependencies:[],
        semantic_source:{kind:'file-content',content_sha256:sha256('A')},
        effect:null,
      },
      {
        id:'target',
        dependencies:[
          {upstream:'upstream',kind:'semantic',selector:'verified-content'},
          {upstream:'upstream',kind:'semantic',selector:'settlement-receipt'},
        ],
        semantic_source:{kind:'file-content',content_sha256:sha256('target')},
        effect:null,
      },
    ],
    lifecycles:[
      {obligation_id:'upstream',status:'DONE',run_id:null},
      {obligation_id:'target',status:'UNREALIZED',run_id:null},
    ],
    receipts:[],
  };

  const runIdentity=(selector:string)=>{
    const stdout=execFileSync(semanticKernel,[],{
      input:JSON.stringify({
        command:'semantic-identity',
        ...requestBase,
        upstream:'upstream',
        selector,
      }),
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    });
    return JSON.parse(stdout) as {resolved:boolean};
  };

  assert.equal(runIdentity('verified-content').resolved,true);
  assert.equal(runIdentity('settlement-receipt').resolved,false);
});

test('serialized realization boundary rejects trusted projection claims',()=>{
  const valid={
    command:'realization-project',
    postcondition:leanPostcondition(filePostcondition()),
    current_key:'key-a',
    runs:[],
    fresh_observation:null,
  };

  for (const field of [
    'reusable',
    'current',
    'fresh_verified',
    'fresh_authoritative_absence',
    'stability',
    'lifecycle',
    'safe_to_reexecute',
  ]) {
    assert.throws(()=>execFileSync(kernel,[],{
      input:JSON.stringify({...valid,[field]:true}),
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    }),field);
  }
});
