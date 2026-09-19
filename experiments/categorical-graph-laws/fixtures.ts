import assert from 'node:assert/strict';

import type {HistoricalRun, Receipt, State} from '../../src/facts.ts';
import {dependsOn, validateGraph} from '../../src/graph.ts';
import type {Dependency, Obligation, WorkStatus} from '../../src/model.ts';
import {
  deriveProjectProjection,
  type ProjectProjection,
} from '../../src/projector.ts';
import {obligationKey} from '../../src/semantic-identity.ts';

export type AssignedLifecycle=
  | 'UNREALIZED'
  | 'EXECUTING'
  | 'WAITING'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

export const LIFECYCLES:AssignedLifecycle[]=[
  'UNREALIZED',
  'EXECUTING',
  'WAITING',
  'RECOVERY_REQUIRED',
  'DONE',
];

export const edgeSlots=(n:number):Array<[number,number]>=>{
  const slots:Array<[number,number]>=[];
  for (let downstream=0;downstream<n;downstream++) {
    for (let upstream=0;upstream<downstream;upstream++) {
      slots.push([downstream,upstream]);
    }
  }
  return slots;
};

export const nodeId=(prefix:string,index:number)=>`${prefix}${index}`;

const obligation=(
  prefix:string,
  index:number,
  dependencies:Dependency[],
):Obligation=>({
  id:nodeId(prefix,index),
  dependencies,
  packet:{version:'v1'},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:`/provider/${nodeId(prefix,index)}`,
    content:`content:${nodeId(prefix,index)}`,
  },
});

export function controlState(prefix:string,n:number,mask:number):State {
  const dependencies=Array.from({length:n},()=>[] as Dependency[]);
  edgeSlots(n).forEach(([downstream,upstream],bit)=>{
    if ((mask&(1<<bit))!==0) {
      dependencies[downstream].push({
        kind:'control',
        upstream:nodeId(prefix,upstream),
      });
    }
  });
  return {
    obligations:Object.fromEntries(
      dependencies.map((deps,index)=>[
        nodeId(prefix,index),
        obligation(prefix,index,deps),
      ]),
    ),
    definition_commits:Object.fromEntries(
      Array.from({length:n},(_,index)=>[
        nodeId(prefix,index),
        `definition:${nodeId(prefix,index)}`,
      ]),
    ),
  };
}

export function typedState(prefix:string,n:number,code:number):State {
  const dependencies=Array.from({length:n},()=>[] as Dependency[]);
  let remaining=code;
  for (const [downstream,upstream] of edgeSlots(n)) {
    const edgeKind=remaining%4;
    remaining=Math.floor(remaining/4);
    if (edgeKind===1) {
      dependencies[downstream].push({
        kind:'control',
        upstream:nodeId(prefix,upstream),
      });
    } else if (edgeKind===2) {
      dependencies[downstream].push({
        kind:'semantic',
        upstream:nodeId(prefix,upstream),
        consumes:{kind:'output',selector:'verified-content'},
      });
    } else if (edgeKind===3) {
      dependencies[downstream].push({
        kind:'semantic',
        upstream:nodeId(prefix,upstream),
        consumes:{kind:'evidence',selector:'settlement-receipt'},
      });
    }
  }
  return {
    obligations:Object.fromEntries(
      dependencies.map((deps,index)=>[
        nodeId(prefix,index),
        obligation(prefix,index,deps),
      ]),
    ),
    definition_commits:Object.fromEntries(
      Array.from({length:n},(_,index)=>[
        nodeId(prefix,index),
        `definition:${nodeId(prefix,index)}`,
      ]),
    ),
  };
}

function runFor(work:Obligation,key:string,suffix:string):HistoricalRun {
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

export function fullyDoneHistory(state:State):{
  runs:Map<string,HistoricalRun>;
  receipts:Map<string,Receipt>;
} {
  const runs=new Map<string,HistoricalRun>();
  const receipts=new Map<string,Receipt>();
  for (const work of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    const projection=deriveProjectProjection({
      state,
      runs,
      receiptsByRun:receipts,
      revision:'baseline',
    });
    const key=projection.semanticKeys.get(work.id);
    assert.ok(key,`semantic key must resolve for ${work.id}`);
    const run=runFor(work,key,'baseline');
    runs.set(run.id,run);
    receipts.set(run.id,receiptFor(run,'DONE'));
  }
  return {runs,receipts};
}

export function doneHistoryExcept(
  state:State,
  excluded:string,
):{
  runs:Map<string,HistoricalRun>;
  receipts:Map<string,Receipt>;
} {
  const runs=new Map<string,HistoricalRun>();
  const receipts=new Map<string,Receipt>();
  for (const work of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    if (work.id===excluded) continue;
    const projection=deriveProjectProjection({
      state,
      runs,
      receiptsByRun:receipts,
      revision:'baseline',
    });
    const projected=projection.work.find(candidate=>candidate.id===work.id);
    if (projected?.status!=='READY') continue;
    const key=projection.semanticKeys.get(work.id);
    assert.ok(key);
    const run=runFor(work,key,'baseline');
    runs.set(run.id,run);
    receipts.set(run.id,receiptFor(run,'DONE'));
  }
  return {runs,receipts};
}

export function lifecycleAssignment(
  state:State,
  code:number,
):{
  runs:Map<string,HistoricalRun>;
  receipts:Map<string,Receipt>;
} {
  const runs=new Map<string,HistoricalRun>();
  const receipts=new Map<string,Receipt>();
  let remaining=code;
  const works=Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id));
  for (const work of works) {
    const lifecycle=LIFECYCLES[remaining%LIFECYCLES.length];
    remaining=Math.floor(remaining/LIFECYCLES.length);
    if (lifecycle==='UNREALIZED') continue;
    const key=obligationKey(state,work,new Map(),new Map());
    assert.ok(key);
    const run=runFor(work,key,`assignment:${code}`);
    runs.set(run.id,run);
    if (lifecycle!=='EXECUTING') {
      receipts.set(run.id,receiptFor(run,lifecycle));
    }
  }
  return {runs,receipts};
}

export function transitiveClosure(state:State):State {
  const closed=structuredClone(state);
  const ids=Object.keys(closed.obligations).sort();
  for (const downstream of ids) {
    const existing=new Set(
      closed.obligations[downstream].dependencies
        .map(edge=>edge.upstream),
    );
    for (const upstream of ids) {
      if (
        downstream!==upstream
        && !existing.has(upstream)
        && dependsOn(state,downstream,upstream)
      ) {
        closed.obligations[downstream].dependencies.push({
          kind:'control',
          upstream,
        });
      }
    }
  }
  validateGraph(closed);
  return closed;
}

export function mutatePacket(state:State,id:string):State {
  const mutated=structuredClone(state);
  mutated.obligations[id].packet={version:'v2'};
  mutated.definition_commits[id]=`definition:${id}:v2`;
  return mutated;
}

export function unionStates(left:State,right:State):State {
  const duplicate=Object.keys(left.obligations)
    .find(id=>right.obligations[id]);
  if (duplicate) throw new Error(`DUPLICATE_UNION_ID:${duplicate}`);
  return {
    obligations:{
      ...structuredClone(left.obligations),
      ...structuredClone(right.obligations),
    },
    definition_commits:{
      ...left.definition_commits,
      ...right.definition_commits,
    },
  };
}

export function unionMaps<T>(left:Map<string,T>,right:Map<string,T>):Map<string,T> {
  return new Map([...left,...right]);
}

export function projectionSnapshot(
  projection:ProjectProjection,
  ids:string[],
):Array<{
  id:string;
  status:WorkStatus;
  semanticKey:string|null;
  claimability:string|null|undefined;
  explanation:unknown;
}> {
  const workById=new Map(projection.work.map(work=>[work.id,work]));
  return [...ids].sort().map(id=>({
    id,
    status:workById.get(id)!.status,
    semanticKey:projection.semanticKeys.get(id)??null,
    claimability:projection.claimabilityErrors.get(id),
    explanation:projection.explanations.get(id),
  }));
}
