import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import {
  deriveLifecycles,
  obligationKey,
} from '../../src/lifecycle.ts';
import { projectWork } from '../../src/eligibility.ts';
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

interface ReceiptFixture {
  run:string;
  disposition:Receipt['disposition'];
  ordinal:number;
}

interface Scenario {
  name:string;
  definitions:DefinitionFixture[];
  runs:RunFixture[];
  receipts:ReceiptFixture[];
  expectedClosure?:string[];
  currentSemanticKeyOverrides?:Record<string,string>;
  extraCurrentSemanticKeys?:Array<[string,string]>;
}

const PROGRAM=join(
  process.cwd(),
  'experiments',
  'datalog-projection',
  'projection.dl',
);

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
  const state:State={obligations:{},definition_commits:{}};
  for (const [id,definition] of currentDefinitions(definitions)) {
    state.obligations[id]=structuredClone(definition.work);
    state.definition_commits[id]=`definition-${definition.ordinal}`;
  }
  return state;
}

function semanticKeys(
  definitions:DefinitionFixture[],
):Map<number,string> {
  const state=currentState(definitions);
  const keys=new Map<number,string>();

  for (const definition of definitions) {
    assert.equal(
      definition.work.dependencies.some(edge=>edge.kind==='semantic'),
      false,
      'this first Datalog slice intentionally stops at the semantic-key boundary',
    );
    const key=obligationKey(
      state,
      definition.work,
      new Map(),
      new Map(),
    );
    assert.ok(key);
    keys.set(definition.ordinal,key);
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
    receipts.set(fixture.run,{
      schema:RECEIPT_SCHEMA,
      run_id:fixture.run,
      obligation_id:run.obligation_id,
      claimed_revision:run.claimed_revision,
      claim_commit:run.claim_commit,
      execution_generation:run.execution_generation,
      execution_authority_commit:run.execution_authority_commit,
      kind:fixture.disposition==='WAITING'
        ? 'judgment-required'
        : fixture.disposition==='RECOVERY_REQUIRED'
          ? 'execution-terminated'
          : 'observation',
      observed:null,
      settled_at:`ordinal:${fixture.ordinal}`,
      disposition:fixture.disposition,
      verified:fixture.disposition==='DONE',
      settlement_commit:`receipt-${fixture.ordinal}`,
    });
  }

  const lifecycles=deriveLifecycles(state,runs,receipts);
  return new Map(
    Object.values(state.obligations)
      .map(work=>[
        work.id,
        projectWork(state,work,'current-revision',lifecycles).status,
      ]),
  );
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

function readPairs(path:string):string[] {
  const text=readFileSync(path,'utf8').trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(line=>line.split('\t').join('->'))
    .sort();
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
      [
        ...[...currentDefinitions(scenario.definitions)].map(([id,definition])=>[
          id,
          scenario.currentSemanticKeyOverrides?.[id]
            ?? keys.get(definition.ordinal)!,
        ] as [string,string]),
        ...(scenario.extraCurrentSemanticKeys??[]),
      ],
    );

    writeFacts(
      join(facts,'dependency.facts'),
      scenario.definitions.flatMap(definition=>
        definition.work.dependencies.map(edge=>[
          definition.work.id,
          `definition-${definition.ordinal}`,
          edge.upstream,
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
        receipt.disposition,
        receipt.ordinal,
      ]),
    );

    execFileSync(
      'souffle',
      ['-F',facts,'-D',output,PROGRAM],
      {stdio:'pipe'},
    );

    const malformedDiagnostics=[
      'duplicate_definition_ordinal',
      'duplicate_semantic_key',
      'duplicate_receipt_ordinal',
      'unknown_dependency',
      'dependency_cycle',
    ] as const;
    for (const diagnostic of malformedDiagnostics) {
      const rows=readPairs(join(output,`${diagnostic}.csv`));
      if (rows.length>0) {
        throw new Error(
          `DATALOG_PROJECTION_INPUT_INVALID:${diagnostic}:${rows.join(',')}`,
        );
      }
    }

    const statuses=new Map<string,WorkStatus>();
    for (const pair of readPairs(join(output,'project_status.csv'))) {
      const [id,status]=pair.split('->');
      assert.equal(statuses.has(id),false,`duplicate status for ${id}`);
      statuses.set(id,status as WorkStatus);
    }

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

const scenarios:Scenario[]=[
  {
    name:'dependency closure and exact-key reuse',
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
      {run:'human-produced-a',disposition:'DONE',ordinal:20},
      {run:'old-run-b',disposition:'DONE',ordinal:21},
    ],
    expectedClosure:['b->a','c->a','c->b'],
  },
  {
    name:'semantic amendment invalidates historical DONE',
    definitions:[
      {work:obligation('a','v1'),ordinal:1},
      {work:obligation('a','v2'),ordinal:2},
    ],
    runs:[
      {id:'old-done',obligation:'a',definitionOrdinal:1,ordinal:10},
    ],
    receipts:[
      {run:'old-done',disposition:'DONE',ordinal:20},
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
    receipts:[{run:'run-a',disposition:'WAITING',ordinal:20}],
  },
  {
    name:'terminated receipt projects RECOVERY_REQUIRED',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{run:'run-a',disposition:'RECOVERY_REQUIRED',ordinal:20}],
  },
  {
    name:'authoritative absence returns exact-key work to READY',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[{run:'run-a',disposition:'READY',ordinal:20}],
  },
  {
    name:'later settlement supersedes earlier recovery receipt',
    definitions:[{work:chainA,ordinal:1}],
    runs:[{id:'run-a',obligation:'a',definitionOrdinal:1,ordinal:10}],
    receipts:[
      {run:'run-a',disposition:'RECOVERY_REQUIRED',ordinal:20},
      {run:'run-a',disposition:'DONE',ordinal:21},
    ],
  },
];

test('Souffle derives the same bounded projection as the TypeScript reference mechanism',()=>{
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

test('changing only material semantic identity removes reuse',()=>{
  const scenario=scenarios.find(candidate=>
    candidate.name==='semantic amendment invalidates historical DONE'
  );
  assert.ok(scenario);

  const expected=typescriptProjection(scenario);
  const actual=datalogProjection(scenario);

  assert.equal(expected.get('a'),'READY');
  assert.equal(actual.statuses.get('a'),'READY');
});

test('current semantic identity may change while the definition stays identical',()=>{
  const stableDefinition=obligation('stable','v1');
  const baseline:Scenario={
    name:'same definition, same semantic key',
    definitions:[{work:stableDefinition,ordinal:1}],
    runs:[{id:'old-done',obligation:'stable',definitionOrdinal:1,ordinal:10}],
    receipts:[{run:'old-done',disposition:'DONE',ordinal:20}],
  };

  const reused=datalogProjection(baseline);
  assert.equal(reused.statuses.get('stable'),'DONE');

  const changed:Scenario={
    ...baseline,
    name:'same definition, changed upstream-derived semantic key',
    currentSemanticKeyOverrides:{
      stable:'sha256:upstream-identity-changed',
    },
  };
  const invalidated=datalogProjection(changed);
  assert.equal(invalidated.statuses.get('stable'),'READY');
});

test('contradictory semantic-key input is rejected before projection is trusted',()=>{
  const stableDefinition=obligation('contradictory','v1');
  const scenario:Scenario={
    name:'duplicate current semantic key',
    definitions:[{work:stableDefinition,ordinal:1}],
    runs:[],
    receipts:[],
    extraCurrentSemanticKeys:[
      ['contradictory','sha256:contradictory-second-key'],
    ],
  };

  assert.throws(
    ()=>datalogProjection(scenario),
    /DATALOG_PROJECTION_INPUT_INVALID:duplicate_semantic_key/,
  );
});
