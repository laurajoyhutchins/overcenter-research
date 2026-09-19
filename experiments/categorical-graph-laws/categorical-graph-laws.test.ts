import assert from 'node:assert/strict';
import test from 'node:test';

import type {HistoricalRun, Receipt} from '../../src/facts.ts';
import {dependsOn, validateGraph} from '../../src/graph.ts';
import type {WorkStatus} from '../../src/model.ts';
import {deriveProjectProjection} from '../../src/projector.ts';
import {
  LIFECYCLES,
  controlState,
  doneHistoryExcept,
  edgeSlots,
  fullyDoneHistory,
  lifecycleAssignment,
  mutatePacket,
  nodeId,
  projectionSnapshot,
  transitiveClosure,
  typedState,
  unionMaps,
  unionStates,
} from './fixtures.ts';

test('strong thin-category factorization is false: same reachability can project differently',t=>{
  let first:null|{
    n:number;
    mask:number;
    reopened:string;
    target:string;
    originalStatus:WorkStatus;
    closureStatus:WorkStatus;
  }=null;

  outer:
  for (let n=1;n<=4;n++) {
    const target=nodeId('n',n-1);
    const graphCount=1<<(n*(n-1)/2);
    for (let mask=0;mask<graphCount;mask++) {
      const state=controlState('n',n,mask);
      const closure=transitiveClosure(state);
      const direct=new Set(
        state.obligations[target].dependencies.map(edge=>edge.upstream),
      );
      const history=doneHistoryExcept(state,target);

      for (let reopenedIndex=0;reopenedIndex<n-1;reopenedIndex++) {
        const reopened=nodeId('n',reopenedIndex);
        if (direct.has(reopened) || !dependsOn(state,target,reopened)) continue;

        const original=deriveProjectProjection({
          state:mutatePacket(state,reopened),
          runs:history.runs,
          receiptsByRun:history.receipts,
          revision:'original',
        });
        const closed=deriveProjectProjection({
          state:mutatePacket(closure,reopened),
          runs:history.runs,
          receiptsByRun:history.receipts,
          revision:'closure',
        });
        const originalStatus=original.work.find(work=>work.id===target)!.status;
        const closureStatus=closed.work.find(work=>work.id===target)!.status;
        if (originalStatus!==closureStatus) {
          first={n,mask,reopened,target,originalStatus,closureStatus};
          assert.equal(
            original.semanticKeys.get(target),
            closed.semanticKeys.get(target),
            'semantic identity stays equal even when current eligibility differs',
          );
          break outer;
        }
      }
    }
  }

  assert.deepEqual(first,{
    n:3,
    mask:5,
    reopened:'n0',
    target:'n2',
    originalStatus:'READY',
    closureStatus:'BLOCKED',
  });
  t.diagnostic(
    'minimal counterexample: n0 -> n1 -> n2; reopening n0 leaves n1 DONE, so n2 is READY in the chain but BLOCKED after adding the transitive n0 -> n2 control edge',
  );
});

test('semantic identity is invariant under control-edge subdivision through four nodes',()=>{
  let typedGraphs=0;
  let subdivisions=0;

  for (let n=1;n<=4;n++) {
    const graphCount=4**(n*(n-1)/2);
    for (let code=0;code<graphCount;code++) {
      const state=typedState('n',n,code);
      validateGraph(state);
      const history=fullyDoneHistory(state);
      const baseline=deriveProjectProjection({
        state,
        runs:history.runs,
        receiptsByRun:history.receipts,
        revision:'baseline',
      });

      for (let downstream=0;downstream<n;downstream++) {
        const downstreamId=nodeId('n',downstream);
        const dependencies=state.obligations[downstreamId].dependencies;
        for (let edgeIndex=0;edgeIndex<dependencies.length;edgeIndex++) {
          const edge=dependencies[edgeIndex];
          if (edge.kind!=='control') continue;

          const subdivided=structuredClone(state);
          const x=`x:${downstream}:${edgeIndex}`;
          subdivided.obligations[downstreamId].dependencies.splice(
            edgeIndex,
            1,
            {kind:'control',upstream:x},
          );
          subdivided.obligations[x]={
            id:x,
            dependencies:[{kind:'control',upstream:edge.upstream}],
            packet:{role:'control-subdivision'},
            postcondition:{
              verifier:'file-content-equals/v1',
              path:`/provider/${x}`,
              content:`content:${x}`,
            },
          };
          subdivided.definition_commits[x]=`definition:${x}`;
          validateGraph(subdivided);

          const projected=deriveProjectProjection({
            state:subdivided,
            runs:history.runs,
            receiptsByRun:history.receipts,
            revision:'subdivided',
          });
          for (const originalId of Object.keys(state.obligations)) {
            assert.equal(
              projected.semanticKeys.get(originalId),
              baseline.semanticKeys.get(originalId),
              `semantic identity changed n=${n} code=${code} edge=${downstreamId}<-${edge.upstream}`,
            );
          }
          subdivisions++;
        }
      }
      typedGraphs++;
    }
  }

  assert.deepEqual(
    {typedGraphs,subdivisions},
    {typedGraphs:4_165,subdivisions:6_193},
  );
});

test('disjoint union preserves every per-obligation projection through two-node components',()=>{
  type Fixture={
    state:ReturnType<typeof controlState>;
    runs:Map<string,HistoricalRun>;
    receipts:Map<string,Receipt>;
    projection:ReturnType<typeof deriveProjectProjection>;
    ids:string[];
  };

  const fixtures=(prefix:string):Fixture[]=>{
    const out:Fixture[]=[];
    for (let n=1;n<=2;n++) {
      const graphCount=1<<(n*(n-1)/2);
      const assignmentCount=LIFECYCLES.length**n;
      for (let mask=0;mask<graphCount;mask++) {
        const state=controlState(prefix,n,mask);
        for (let assignment=0;assignment<assignmentCount;assignment++) {
          const history=lifecycleAssignment(state,assignment);
          const projection=deriveProjectProjection({
            state,
            runs:history.runs,
            receiptsByRun:history.receipts,
            revision:'component',
          });
          out.push({
            state,
            runs:history.runs,
            receipts:history.receipts,
            projection,
            ids:Object.keys(state.obligations),
          });
        }
      }
    }
    return out;
  };

  const left=fixtures('a');
  const right=fixtures('z');
  let pairs=0;
  for (const a of left) {
    for (const z of right) {
      const state=unionStates(a.state,z.state);
      validateGraph(state);
      const union=deriveProjectProjection({
        state,
        runs:unionMaps(a.runs,z.runs),
        receiptsByRun:unionMaps(a.receipts,z.receipts),
        revision:'component',
      });

      assert.deepEqual(
        projectionSnapshot(union,a.ids),
        projectionSnapshot(a.projection,a.ids),
      );
      assert.deepEqual(
        projectionSnapshot(union,z.ids),
        projectionSnapshot(z.projection,z.ids),
      );
      pairs++;
    }
  }
  assert.equal(pairs,3_025);
});

test('global readyWork selection is intentionally not a disjoint-union homomorphism',()=>{
  const a=controlState('a',1,0);
  const z=controlState('z',1,0);
  const emptyRuns=new Map<string,HistoricalRun>();
  const emptyReceipts=new Map<string,Receipt>();

  const pa=deriveProjectProjection({
    state:a,
    runs:emptyRuns,
    receiptsByRun:emptyReceipts,
    revision:'component',
  });
  const pz=deriveProjectProjection({
    state:z,
    runs:emptyRuns,
    receiptsByRun:emptyReceipts,
    revision:'component',
  });
  const union=deriveProjectProjection({
    state:unionStates(a,z),
    runs:emptyRuns,
    receiptsByRun:emptyReceipts,
    revision:'component',
  });

  assert.equal(pa.readyWork?.id,'a0');
  assert.equal(pz.readyWork?.id,'z0');
  assert.equal(union.readyWork?.id,'a0');
  assert.equal(
    union.work.filter(work=>work.status==='READY').length,
    2,
    'both componentwise READY facts survive; only the single scheduler choice is global',
  );
});
