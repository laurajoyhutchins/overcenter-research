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

import {
  RECEIPT_SCHEMA,
  type HistoricalRun,
  type Receipt,
  type ReceiptFact,
  type State,
} from '../../src/facts.ts';
import { localFileEnoentEvidence } from '../../src/evidence.ts';
import { obligationKey } from '../../src/semantic-identity.ts';
import { deriveProjectProjection } from '../../src/projector.ts';
import {
  projectReceipt,
} from '../../src/projection.ts';
import type {
  Dependency,
  Obligation,
  WorkStatus,
} from '../../src/model.ts';

interface DefinitionFixture {
  work:Obligation;
  ordinal:number;
}

interface RunFixture {
  id:string;
  obligation:string;
  definitionOrdinal:number;
  ordinal:number;
}

type ObservationEvidence='verified'|'accepted-absence'|'uncertain';

type ReceiptFixture =
  | {
      run:string;
      ordinal:number;
      kind:'observation';
      evidence:ObservationEvidence;
    }
  | {
      run:string;
      ordinal:number;
      kind:'judgment-required'|'execution-terminated';
    };

interface Scenario {
  name:string;
  definitions:DefinitionFixture[];
  runs:RunFixture[];
  receipts:ReceiptFixture[];
  expectedClosure?:string[];
  currentSemanticKeyOverrides?:Record<string,string>;
  omitObservationJudgments?:Array<string>;
  rejectedRealizationRuns?:Array<string>;
}

const PROGRAM=join(
  process.cwd(),
  'experiments',
  'datalog-projection',
  'projection.dl',
);

const sha256=(value:string)=>
  createHash('sha256').update(value).digest('hex');

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
      path:`/provider/${id}/${version}`,
      content:`${id}:${version}`,
    },
  };
}

function currentDefinitions(
  definitions:DefinitionFixture[],
):Map<string,DefinitionFixture> {
  const current=new Map<string,DefinitionFixture>();
  for (const definition of definitions) {
    const existing=current.get(definition.work.id);
    if (!existing || definition.ordinal>existing.ordinal) {
      current.set(definition.work.id,definition);
    }
  }
  return current;
}

function currentState(definitions:DefinitionFixture[]):State {
  const state:State={obligations:{},definition_ids:{}};
  for (const [id,definition] of currentDefinitions(definitions)) {
    state.obligations[id]=structuredClone(definition.work);
    state.definition_ids[id]=`definition-${definition.ordinal}`;
  }
  return state;
}

function semanticKeys(
  definitions:DefinitionFixture[],
):Map<number,string> {
  const state=currentState(definitions);
  const keys=new Map<number,string>();

  for (const definition of definitions) {
    const key=obligationKey(
      state,
      definition.work,
      new Map(),
      new Map(),
    );
    if (key) keys.set(definition.ordinal,key);
  }
  return keys;
}

function latestReceipts(
  receipts:ReceiptFixture[],
):Map<string,ReceiptFixture> {
  const latest=new Map<string,ReceiptFixture>();
  for (const receipt of receipts) {
    const existing=latest.get(receipt.run);
    if (!existing || receipt.ordinal>existing.ordinal) {
      latest.set(receipt.run,receipt);
    }
  }
  return latest;
}

function observationFor(
  work:Obligation,
  evidence:ObservationEvidence,
):ReceiptFact['observed'] {
  assert.equal(work.postcondition.verifier,'file-content-equals/v1');
  const path=work.postcondition.path;
  if (evidence==='verified') {
    const digest=sha256(work.postcondition.content);
    return {
      verifier:'file-content-equals/v1',
      path,
      expected_sha256:digest,
      actual_sha256:digest,
      mutation_certainty:'present',
    };
  }
  if (evidence==='accepted-absence') {
    return {
      verifier:'file-content-equals/v1',
      path,
      mutation_certainty:'absent',
      absence_evidence:localFileEnoentEvidence(path),
    };
  }
  return {
    verifier:'file-content-equals/v1',
    path,
    mutation_certainty:'uncertain',
  };
}

function receiptFact(
  fixture:ReceiptFixture,
  run:HistoricalRun,
):ReceiptFact {
  return {
    schema:RECEIPT_SCHEMA,
    run_id:run.id,
    obligation_id:run.obligation_id,
    claimed_revision:run.claimed_revision,
    claim_commit:run.claim_commit,
    execution_generation:run.execution_generation,
    execution_authority_commit:run.execution_authority_commit,
    kind:fixture.kind,
    observed:fixture.kind==='observation'
      ? observationFor(run.obligation,fixture.evidence)
      : null,
    settled_at:`ordinal:${fixture.ordinal}`,
  };
}

function typescriptProjection(scenario:Scenario):Map<string,WorkStatus> {
  const state=currentState(scenario.definitions);
  const keys=semanticKeys(scenario.definitions);
  const definitionsByOrdinal=new Map(
    scenario.definitions.map(definition=>[definition.ordinal,definition]),
  );
  const runs=new Map<string,HistoricalRun>();

  for (const fixture of scenario.runs) {
    const definition=definitionsByOrdinal.get(fixture.definitionOrdinal);
    assert.ok(definition);
    assert.equal(definition.work.id,fixture.obligation);
    const key=keys.get(fixture.definitionOrdinal);
    assert.ok(key);

    runs.set(fixture.id,{
      id:fixture.id,
      obligation_id:fixture.obligation,
      claimed_revision:`revision-${fixture.ordinal}`,
      claim_commit:`claim-${fixture.ordinal}`,
      obligation_key:key,
      execution_generation:1,
      execution_authority_commit:`claim-${fixture.ordinal}`,
      execution_capability_sha256:'0'.repeat(64),
      obligation:structuredClone(definition.work),
      definition_commit:`definition-${fixture.definitionOrdinal}`,
    });
  }

  const receipts=new Map<string,Receipt>();
  for (const fixture of latestReceipts(scenario.receipts).values()) {
    const run=runs.get(fixture.run);
    assert.ok(run);
    const fact=receiptFact(fixture,run);
    receipts.set(
      fixture.run,
      projectReceipt(fact,run.obligation,`receipt-${fixture.ordinal}`),
    );
  }

  const inadmissible=new Set(scenario.rejectedRealizationRuns??[]);
  const currentRealizationJudgments=new Map(
    [...runs.keys()].map(runId=>[
      runId,
      inadmissible.has(runId)
        ? {
            state:'rejected' as const,
            reason:'CURRENT_POSTCONDITION_NOT_VERIFIED' as const,
          }
        : {
            state:'admissible' as const,
            reason:'CURRENT_POSTCONDITION_VERIFIED' as const,
          },
    ]),
  );
  const project=deriveProjectProjection({
    state,
    runs,
    receiptsByRun:receipts,
    revision:'current-revision',
    currentRealizationJudgments,
  });
  return new Map(project.work.map(work=>[work.id,work.status]));
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

function readRows(path:string):string[] {
  const text=readFileSync(path,'utf8').trim();
  return text ? text.split(/\r?\n/).sort() : [];
}

function readPairs(path:string):string[] {
  return readRows(path)
    .map(line=>line.split('\t').join('->'))
    .sort();
}



function judgment(
  receipt:Extract<ReceiptFixture,{kind:'observation'}>,
):[string,string] {
  switch (receipt.evidence) {
    case 'verified': return ['true','false'];
    case 'accepted-absence': return ['false','true'];
    case 'uncertain': return ['false','false'];
  }
}

function datalogProjection(
  scenario:Scenario,
):{
  statuses:Map<string,WorkStatus>;
  closure:string[];
} {
  const root=mkdtempSync(join(tmpdir(),'overcenter-datalog-'));
  const facts=join(root,'facts');
  const output=join(root,'output');
  mkdirSync(facts);
  mkdirSync(output);

  try {
    const keys=semanticKeys(scenario.definitions);
    const definitionByOrdinal=new Map(
      scenario.definitions.map(definition=>[definition.ordinal,definition]),
    );

    writeFacts(
      join(facts,'definition.facts'),
      scenario.definitions.map(definition=>[
        definition.work.id,
        `definition-${definition.ordinal}`,
        definition.ordinal,
      ]),
    );

    writeFacts(
      join(facts,'current_semantic_key.facts'),
      [...currentDefinitions(scenario.definitions)].flatMap(([id,definition])=>{
        const key=scenario.currentSemanticKeyOverrides?.[id]
          ?? keys.get(definition.ordinal);
        return key ? [[id,key] as [string,string]] : [];
      }),
    );

    writeFacts(
      join(facts,'dependency.facts'),
      scenario.definitions.flatMap(definition=>
        definition.work.dependencies.map(edge=>[
          definition.work.id,
          `definition-${definition.ordinal}`,
          edge.upstream,
          edge.kind,
        ]),
      ),
    );

    writeFacts(
      join(facts,'run.facts'),
      scenario.runs.map(run=>{
        const definition=definitionByOrdinal.get(run.definitionOrdinal);
        assert.ok(definition);
        return [
          run.id,
          run.obligation,
          keys.get(run.definitionOrdinal)!,
          run.ordinal,
        ];
      }),
    );

    writeFacts(
      join(facts,'receipt.facts'),
      scenario.receipts.map(receipt=>[
        receipt.run,
        receipt.kind,
        receipt.ordinal,
      ]),
    );

    const inadmissible=new Set(scenario.rejectedRealizationRuns??[]);
    const latest=latestReceipts(scenario.receipts);
    writeFacts(
      join(facts,'current_realization_admissible.facts'),
      scenario.runs.flatMap(run=>{
        if (inadmissible.has(run.id)) return [];
        const receipt=latest.get(run.id);
        if (
          receipt?.kind==='observation'
          && receipt.evidence==='verified'
        ) {
          return [[run.id,run.obligation]];
        }
        return [];
      }),
    );

    const omitted=new Set(scenario.omitObservationJudgments??[]);
    writeFacts(
      join(facts,'observation_judgment.facts'),
      scenario.receipts.flatMap(receipt=>{
        if (receipt.kind!=='observation') return [];
        const coordinate=`${receipt.run}:${receipt.ordinal}`;
        if (omitted.has(coordinate)) return [];
        const [verified,acceptedAbsence]=judgment(receipt);
        return [[
          receipt.run,
          receipt.ordinal,
          verified,
          acceptedAbsence,
        ]];
      }),
    );

    execFileSync(
      'souffle',
      ['-F',facts,'-D',output,PROGRAM],
      {stdio:'pipe'},
    );

    const statuses=new Map<string,WorkStatus>();
    for (const pair of readPairs(join(output,'project_status.csv'))) {
      const [id,status]=pair.split('->');
      assert.equal(statuses.has(id),false,`duplicate status for ${id}`);
      statuses.set(id,status as WorkStatus);
    }

    assert.equal(
      statuses.size,
      currentDefinitions(scenario.definitions).size,
      'validated input must project exactly one public status per current obligation',
    );

    return {
      statuses,
      closure:readPairs(join(output,'dependency_closure.csv')),
    };
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

const chainA=obligation('a','v1');
const chainB=obligation('b','v1',[{kind:'control',upstream:'a'}]);
const chainC=obligation('c','v1',[{kind:'control',upstream:'b'}]);
const semanticB=obligation('semantic-b','v1',[{
  kind:'semantic',
  upstream:'a',
  consumes:{kind:'output',selector:'verified-content'},
}]);

const scenarios:Scenario[]=[
  {
    name:'dependency closure and exact-key admissible reuse',
    definitions:[
      {work:chainA,ordinal:1},
      {work:chainB,ordinal:2},
      {work:chainC,ordinal:3},
    ],
    runs:[
      {id:'human-produced-a',obligation:'a',definitionOrdinal:1,ordinal:10},
      {id:'old-run-b',obligation:'b',definitionOrdinal:2,ordinal:11},
    ],
    receipts:[
      {run:'human-produced-a',kind:'observation',evidence:'verified',ordinal:20},
      {run:'old-run-b',kind:'observation',evidence:'verified',ordinal:21},
    ],
    expectedClosure:['b->a','c->a','c->b'],
  },
  {
    name:'unresolved semantic dependency may legitimately have no current key',
    definitions:[
      {work:chainA,ordinal:1},
      {work:semanticB,ordinal:2},
    ],
    runs:[],
    receipts:[],
  },
  {
    name:'material amendment invalidates historical DONE',
    definitions:[
      {work:obligation('a','v1'),ordinal:1},
      {work:obligation('a','v2'),ordinal:2},
    ],
    runs:[
      {id:'old-done',obligation:'a',definitionOrdinal:1,ordinal:10},
    ],
    receipts:[
      {run:'old-done',kind:'observation',evidence:'verified',ordinal:20},
    ],
  },
  {
    name:'unsettled matching run projects EXECUTING and blocks dependents',
    definitions:[
      {work:chainA,ordinal:1},
      {work:chainB,ordinal:2},
    ],
    runs:[
      {id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10},
    ],
    receipts:[],
  },
  {
    name:'judgment-required receipt projects WAITING',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{run:'run-a',kind:'judgment-required',ordinal:20}],
  },
  {
    name:'terminated receipt projects RECOVERY_REQUIRED',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{run:'run-a',kind:'execution-terminated',ordinal:20}],
  },
  {
    name:'accepted authoritative absence returns work to READY',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{
      run:'run-a',
      kind:'observation',
      evidence:'accepted-absence',
      ordinal:20,
    }],
  },
  {
    name:'uncertain observation remains RECOVERY_REQUIRED',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{
      run:'run-a',
      kind:'observation',
      evidence:'uncertain',
      ordinal:20,
    }],
  },
  {
    name:'later verified observation supersedes recovery evidence',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[
      {run:'run-a',kind:'execution-terminated',ordinal:20},
      {run:'run-a',kind:'observation',evidence:'verified',ordinal:21},
    ],
  },
];

test('Souffle agrees with TypeScript from semantic evidence downward',()=>{
  for (const scenario of scenarios) {
    const expected=typescriptProjection(scenario);
    const actual=datalogProjection(scenario);

    assert.deepEqual(
      [...actual.statuses.entries()].sort(),
      [...expected.entries()].sort(),
      scenario.name,
    );

    if (scenario.expectedClosure) {
      assert.deepEqual(actual.closure,scenario.expectedClosure,scenario.name);
    }
  }
});

test('same definition with a changed current semantic key loses reuse without invalidation state',()=>{
  const stableDefinition=obligation('stable','v1');
  const baseline:Scenario={
    name:'same definition, same semantic key',
    definitions:[{work:stableDefinition,ordinal:1}],
    runs:[{id:'old-done',obligation:'stable',definitionOrdinal:1,ordinal:10}],
    receipts:[{
      run:'old-done',
      kind:'observation',
      evidence:'verified',
      ordinal:20,
    }],
  };

  assert.equal(datalogProjection(baseline).statuses.get('stable'),'DONE');

  const changed:Scenario={
    ...baseline,
    name:'same definition, changed upstream-derived semantic key',
    currentSemanticKeyOverrides:{
      stable:'sha256:upstream-identity-changed',
    },
  };

  assert.equal(datalogProjection(changed).statuses.get('stable'),'READY');
});

test('an uninterpretable latest receipt fails closed to RECOVERY_REQUIRED',()=>{
  const scenario:Scenario={
    name:'missing semantic judgment',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{
      run:'run-a',
      kind:'observation',
      evidence:'verified',
      ordinal:20,
    }],
    omitObservationJudgments:['run-a:20'],
  };

  assert.equal(
    datalogProjection(scenario).statuses.get('a'),
    'RECOVERY_REQUIRED',
  );
});


test('mutable historical DONE can be rejected by current realization semantics',()=>{
  const scenario:Scenario={
    name:'known TypeScript mutable-reuse gap',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{
      run:'run-a',
      kind:'observation',
      evidence:'verified',
      ordinal:20,
    }],
    rejectedRealizationRuns:['run-a'],
  };

  // Both implementations consume the stronger current admissibility judgment.
  assert.equal(typescriptProjection(scenario).get('a'),'READY');
  assert.equal(datalogProjection(scenario).statuses.get('a'),'READY');
});
