import assert from 'node:assert/strict';
import test from 'node:test';

import {validateAdmission} from '../../src/authority/admission.ts';
import type {HistoricalRun, Receipt, State} from '../../src/authority/facts.ts';
import {dependsOn, validateGraph} from '../../src/graph/topology.ts';
import type {Dependency, Obligation, WorkStatus} from '../../src/model.ts';
import {deriveProjectProjection} from '../../src/authority/project-state.ts';
import {obligationKey} from '../../src/graph/identity.ts';

type AssignedLifecycle=
  | 'UNREALIZED'
  | 'EXECUTING'
  | 'WAITING'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

const LIFECYCLES:AssignedLifecycle[]=[
  'UNREALIZED',
  'EXECUTING',
  'WAITING',
  'RECOVERY_REQUIRED',
  'DONE',
];

const id=(index:number)=>`n${index}`;
const edgeSlots=(n:number):Array<[number,number]>=>{
  const slots:Array<[number,number]>=[];
  for (let downstream=0;downstream<n;downstream++) {
    for (let upstream=0;upstream<downstream;upstream++) {
      slots.push([downstream,upstream]);
    }
  }
  return slots;
};

const obligation=(index:number,dependencies:Dependency[]):Obligation=>({
  id:id(index),
  dependencies,
  packet:{version:'v1'},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:`/provider/${id(index)}`,
    content:`content:${id(index)}`,
  },
});

function stateFromMask(n:number,mask:number):State {
  const dependencies=Array.from({length:n},()=>[] as Dependency[]);
  edgeSlots(n).forEach(([downstream,upstream],bit)=>{
    if ((mask&(1<<bit))!==0) {
      dependencies[downstream].push({kind:'control',upstream:id(upstream)});
    }
  });
  return {
    obligations:Object.fromEntries(
      dependencies.map((deps,index)=>[id(index),obligation(index,deps)]),
    ),
    definition_commits:Object.fromEntries(
      Array.from({length:n},(_,index)=>[id(index),`definition:${id(index)}`]),
    ),
  };
}

function typedState(n:number,code:number):State {
  const dependencies=Array.from({length:n},()=>[] as Dependency[]);
  let remaining=code;
  for (const [downstream,upstream] of edgeSlots(n)) {
    const edgeKind=remaining%4;
    remaining=Math.floor(remaining/4);
    if (edgeKind===1) {
      dependencies[downstream].push({kind:'control',upstream:id(upstream)});
    } else if (edgeKind===2) {
      dependencies[downstream].push({
        kind:'semantic',
        upstream:id(upstream),
        consumes:{kind:'output',selector:'verified-content'},
      });
    } else if (edgeKind===3) {
      dependencies[downstream].push({
        kind:'semantic',
        upstream:id(upstream),
        consumes:{kind:'evidence',selector:'settlement-receipt'},
      });
    }
  }
  return {
    obligations:Object.fromEntries(
      dependencies.map((deps,index)=>[id(index),obligation(index,deps)]),
    ),
    definition_commits:Object.fromEntries(
      Array.from({length:n},(_,index)=>[id(index),`definition:${id(index)}`]),
    ),
  };
}

function reachability(state:State,n:number):boolean[][] {
  const reach=Array.from({length:n},(_,i)=>
    Array.from({length:n},(_,j)=>i===j),
  );
  for (let downstream=0;downstream<n;downstream++) {
    for (const edge of state.obligations[id(downstream)].dependencies) {
      const upstream=Number(edge.upstream.slice(1));
      reach[downstream][upstream]=true;
    }
  }
  for (let k=0;k<n;k++) {
    for (let i=0;i<n;i++) {
      if (!reach[i][k]) continue;
      for (let j=0;j<n;j++) {
        reach[i][j]=reach[i][j] || reach[k][j];
      }
    }
  }
  return reach;
}

function *permutations(values:number[]):Generator<number[]> {
  if (values.length<=1) {
    yield [...values];
    return;
  }
  for (let i=0;i<values.length;i++) {
    const head=values[i];
    const rest=[...values.slice(0,i),...values.slice(i+1)];
    for (const tail of permutations(rest)) yield [head,...tail];
  }
}

function canonicalGraphKey(state:State,n:number):string {
  const direct=new Set<string>();
  for (let downstream=0;downstream<n;downstream++) {
    for (const edge of state.obligations[id(downstream)].dependencies) {
      direct.add(`${downstream}>${Number(edge.upstream.slice(1))}`);
    }
  }

  let best:string|null=null;
  for (const permutation of permutations(Array.from({length:n},(_,i)=>i))) {
    let candidate='';
    for (let u=0;u<n;u++) {
      for (let v=0;v<n;v++) {
        if (u===v) continue;
        candidate+=direct.has(`${permutation[u]}>${permutation[v]}`)?'1':'0';
      }
    }
    if (best===null || candidate<best) best=candidate;
  }
  return best??'';
}

function decodeLifecycleAssignment(n:number,code:number):AssignedLifecycle[] {
  const result:AssignedLifecycle[]=[];
  let remaining=code;
  for (let i=0;i<n;i++) {
    result.push(LIFECYCLES[remaining%LIFECYCLES.length]);
    remaining=Math.floor(remaining/LIFECYCLES.length);
  }
  return result;
}

function runFor(
  work:Obligation,
  key:string,
  suffix:string,
):HistoricalRun {
  return {
    id:`run:${work.id}:${suffix}`,
    obligation_id:work.id,
    claimed_revision:`revision:${suffix}`,
    claim_commit:`claim:${work.id}:${suffix}`,
    obligation_key:key,
    execution_generation:1,
    execution_authority_commit:`claim:${work.id}:${suffix}`,
    execution_capability_sha256:'0'.repeat(64),
    obligation:structuredClone(work),
    definition_commit:`definition:${work.id}`,
  };
}

function receiptFor(
  run:HistoricalRun,
  disposition:Extract<AssignedLifecycle,'WAITING'|'RECOVERY_REQUIRED'|'DONE'>,
):Receipt {
  const kind=disposition==='WAITING'
    ? 'judgment-required'
    : disposition==='RECOVERY_REQUIRED'
      ? 'execution-terminated'
      : 'observation';
  return {
    schema:'overcenter-git-receipt-v5',
    run_id:run.id,
    obligation_id:run.obligation_id,
    claimed_revision:run.claimed_revision,
    claim_commit:run.claim_commit,
    execution_generation:run.execution_generation,
    execution_authority_commit:run.execution_authority_commit,
    kind,
    observed:null,
    settled_at:`settled:${run.id}`,
    disposition,
    verified:disposition==='DONE',
    settlement_commit:`settlement:${run.id}`,
  };
}

function historyForAssignment(
  state:State,
  assignment:AssignedLifecycle[],
):{
  runs:Map<string,HistoricalRun>;
  receipts:Map<string,Receipt>;
} {
  const runs=new Map<string,HistoricalRun>();
  const receipts=new Map<string,Receipt>();
  for (let i=0;i<assignment.length;i++) {
    const lifecycle=assignment[i];
    if (lifecycle==='UNREALIZED') continue;
    const work=state.obligations[id(i)];
    const key=obligationKey(state,work,new Map(),new Map());
    assert.ok(key);
    const run=runFor(work,key,`assignment:${i}`);
    runs.set(run.id,run);
    if (lifecycle!=='EXECUTING') {
      receipts.set(run.id,receiptFor(run,lifecycle));
    }
  }
  return {runs,receipts};
}

function fullyDoneHistory(
  state:State,
  n:number,
):{
  runs:Map<string,HistoricalRun>;
  receipts:Map<string,Receipt>;
} {
  const runs=new Map<string,HistoricalRun>();
  const receipts=new Map<string,Receipt>();
  for (let i=0;i<n;i++) {
    const projection=deriveProjectProjection({
      state,
      runs,
      receiptsByRun:receipts,
      revision:'baseline',
    });
    const key=projection.semanticKeys.get(id(i));
    assert.ok(key,`semantic key must resolve for ${id(i)}`);
    const run=runFor(state.obligations[id(i)],key,'baseline');
    runs.set(run.id,run);
    receipts.set(run.id,receiptFor(run,'DONE'));
  }
  return {runs,receipts};
}

function addDoneRun(
  state:State,
  workId:string,
  runs:Map<string,HistoricalRun>,
  receipts:Map<string,Receipt>,
  suffix:string,
):void {
  const projection=deriveProjectProjection({
    state,
    runs,
    receiptsByRun:receipts,
    revision:`before:${suffix}`,
  });
  const key=projection.semanticKeys.get(workId);
  assert.ok(key,`semantic key must resolve before ${suffix}`);
  const run=runFor(state.obligations[workId],key,suffix);
  runs.set(run.id,run);
  receipts.set(run.id,receiptFor(run,'DONE'));
}

function semanticDescendants(state:State,root:string):Set<string> {
  const lost=new Set<string>([root]);
  let changed=true;
  while (changed) {
    changed=false;
    for (const work of Object.values(state.obligations)) {
      if (lost.has(work.id)) continue;
      if (work.dependencies.some(edge=>edge.kind==='semantic' && lost.has(edge.upstream))) {
        lost.add(work.id);
        changed=true;
      }
    }
  }
  return lost;
}

function expectedDoneAfterSameOutputResettlement(
  state:State,
  n:number,
  changed:number,
):Set<string> {
  const done=new Set<string>([id(changed)]);
  for (let i=0;i<n;i++) {
    if (i===changed) continue;
    const semantic=state.obligations[id(i)].dependencies
      .filter((edge):edge is Extract<Dependency,{kind:'semantic'}>=>
        edge.kind==='semantic',
      );
    if (!semantic.every(edge=>done.has(edge.upstream))) continue;
    const consumesNewSettlement=semantic.some(edge=>
      edge.upstream===id(changed)
      && edge.consumes.kind==='evidence'
      && edge.consumes.selector==='settlement-receipt',
    );
    if (!consumesNewSettlement) done.add(id(i));
  }
  return done;
}

test('every ordered DAG through six nodes agrees with an independent reachability model',()=>{
  let graphs=0;
  for (let n=1;n<=6;n++) {
    const count=1<<(n*(n-1)/2);
    for (let mask=0;mask<count;mask++) {
      const state=stateFromMask(n,mask);
      validateGraph(state);
      const reference=reachability(state,n);
      for (let from=0;from<n;from++) {
        for (let target=0;target<n;target++) {
          assert.equal(
            dependsOn(state,id(from),id(target)),
            reference[from][target],
            `reachability mismatch n=${n} mask=${mask} ${from}->${target}`,
          );
        }
      }
      graphs++;
    }
  }
  assert.equal(graphs,33_867);
});

test('every absent single edge through five nodes is accepted iff it preserves acyclicity',()=>{
  let challenges=0;
  let accepted=0;
  let rejected=0;
  for (let n=1;n<=5;n++) {
    const count=1<<(n*(n-1)/2);
    for (let mask=0;mask<count;mask++) {
      const state=stateFromMask(n,mask);
      const reference=reachability(state,n);
      const direct=new Set(
        edgeSlots(n)
          .filter((_,bit)=>(mask&(1<<bit))!==0)
          .map(([downstream,upstream])=>`${downstream}>${upstream}`),
      );
      for (let downstream=0;downstream<n;downstream++) {
        for (let upstream=0;upstream<n;upstream++) {
          if (downstream===upstream || direct.has(`${downstream}>${upstream}`)) continue;
          const dependencies=state.obligations[id(downstream)].dependencies;
          dependencies.push({kind:'control',upstream:id(upstream)});
          const shouldReject=reference[upstream][downstream];
          if (shouldReject) {
            assert.throws(()=>validateGraph(state),/DEPENDENCY_CYCLE/);
            rejected++;
          } else {
            validateGraph(state);
            accepted++;
          }
          dependencies.pop();
          challenges++;
        }
      }
    }
  }
  assert.deepEqual(
    {challenges,accepted,rejected},
    {challenges:15_975,accepted:9_425,rejected:6_550},
  );
});

test('topological enumeration contains every unlabeled DAG through five nodes',()=>{
  const expected=[1,2,6,31,302];
  const actual:number[]=[];
  for (let n=1;n<=5;n++) {
    const canonical=new Set<string>();
    const count=1<<(n*(n-1)/2);
    for (let mask=0;mask<count;mask++) {
      canonical.add(canonicalGraphKey(stateFromMask(n,mask),n));
    }
    actual.push(canonical.size);
  }
  assert.deepEqual(actual,expected);
});

test('projector agrees with the reference lifecycle rule for every assignment through four nodes',()=>{
  let scenarios=0;
  for (let n=1;n<=4;n++) {
    const graphCount=1<<(n*(n-1)/2);
    const assignmentCount=LIFECYCLES.length**n;
    for (let mask=0;mask<graphCount;mask++) {
      const state=stateFromMask(n,mask);
      for (let code=0;code<assignmentCount;code++) {
        const assignment=decodeLifecycleAssignment(n,code);
        const {runs,receipts}=historyForAssignment(state,assignment);
        const projection=deriveProjectProjection({
          state,
          runs,
          receiptsByRun:receipts,
          revision:'bounded',
        });

        const expectedErrors=new Map<string,string|null>();
        const expectedStatuses=new Map<string,WorkStatus>();
        for (let i=0;i<n;i++) {
          const work=state.obligations[id(i)];
          const assigned=assignment[i];
          if (assigned!=='UNREALIZED') {
            expectedErrors.set(work.id,'NOT_READY');
            expectedStatuses.set(work.id,assigned);
            continue;
          }
          const dependenciesDone=work.dependencies.every(edge=>
            assignment[Number(edge.upstream.slice(1))]==='DONE',
          );
          expectedErrors.set(
            work.id,
            dependenciesDone?null:'DEPENDENCIES_NOT_DONE',
          );
          expectedStatuses.set(
            work.id,
            dependenciesDone?'READY':'BLOCKED',
          );
        }

        assert.deepEqual(
          new Map(projection.work.map(work=>[work.id,work.status])),
          expectedStatuses,
          `status mismatch n=${n} mask=${mask} assignment=${code}`,
        );
        assert.deepEqual(
          projection.claimabilityErrors,
          expectedErrors,
          `claimability mismatch n=${n} mask=${mask} assignment=${code}`,
        );
        const expectedReady=[...expectedErrors]
          .find(([,error])=>error===null)?.[0]??null;
        assert.equal(
          projection.readyWork?.id??null,
          expectedReady,
          `ready selection mismatch n=${n} mask=${mask} assignment=${code}`,
        );
        scenarios++;
      }
    }
  }
  assert.equal(scenarios,41_055);
});

test('every typed DAG through four nodes invalidates exactly the semantic descendant cone',()=>{
  let typedGraphs=0;
  let mutations=0;
  for (let n=1;n<=4;n++) {
    const graphCount=4**(n*(n-1)/2);
    for (let code=0;code<graphCount;code++) {
      const state=typedState(n,code);
      validateAdmission(state);
      const {runs,receipts}=fullyDoneHistory(state,n);
      const baseline=deriveProjectProjection({
        state,
        runs,
        receiptsByRun:receipts,
        revision:'baseline',
      });
      assert.ok(baseline.work.every(work=>work.status==='DONE'));

      for (let changed=0;changed<n;changed++) {
        const mutated=structuredClone(state);
        const postcondition=mutated.obligations[id(changed)].postcondition;
        assert.equal(postcondition.verifier,'file-content-equals/v1');
        postcondition.content+=`:changed:${changed}`;
        mutated.definition_commits[id(changed)]=`definition:${id(changed)}:changed`;

        const projection=deriveProjectProjection({
          state:mutated,
          runs,
          receiptsByRun:receipts,
          revision:'changed',
        });
        const lost=semanticDescendants(state,id(changed));
        const actualLost=new Set(
          projection.work
            .filter(work=>work.status!=='DONE')
            .map(work=>work.id),
        );
        assert.deepEqual(
          actualLost,
          lost,
          `semantic invalidation mismatch n=${n} code=${code} changed=${changed}`,
        );
        assert.equal(
          projection.work.find(work=>work.id===id(changed))?.status,
          'READY',
          `amended obligation should be re-executable n=${n} code=${code} changed=${changed}`,
        );
        mutations++;
      }
      typedGraphs++;
    }
  }
  assert.deepEqual({typedGraphs,mutations},{typedGraphs:4_165,mutations:16_585});
});

test('same-output resettlement preserves exactly the semantic identities that remain stable',()=>{
  let resumptions=0;
  for (let n=1;n<=4;n++) {
    const graphCount=4**(n*(n-1)/2);
    for (let code=0;code<graphCount;code++) {
      const state=typedState(n,code);
      const baseline=fullyDoneHistory(state,n);
      for (let changed=0;changed<n;changed++) {
        const mutated=structuredClone(state);
        mutated.obligations[id(changed)].packet={version:'v2'};
        mutated.definition_commits[id(changed)]=`definition:${id(changed)}:packet-v2`;
        const runs=new Map(baseline.runs);
        const receipts=new Map(baseline.receipts);

        const before=deriveProjectProjection({
          state:mutated,
          runs,
          receiptsByRun:receipts,
          revision:'packet-changed',
        });
        assert.notEqual(before.lifecycles.get(id(changed))?.status,'DONE');

        addDoneRun(
          mutated,
          id(changed),
          runs,
          receipts,
          `packet-v2:${changed}`,
        );
        const after=deriveProjectProjection({
          state:mutated,
          runs,
          receiptsByRun:receipts,
          revision:'packet-resettled',
        });
        const expectedDone=expectedDoneAfterSameOutputResettlement(
          state,
          n,
          changed,
        );
        const actualDone=new Set(
          after.work
            .filter(work=>work.status==='DONE')
            .map(work=>work.id),
        );
        assert.deepEqual(
          actualDone,
          expectedDone,
          `semantic identity reuse mismatch n=${n} code=${code} changed=${changed}`,
        );
        resumptions++;
      }
    }
  }
  assert.equal(resumptions,16_585);
});
