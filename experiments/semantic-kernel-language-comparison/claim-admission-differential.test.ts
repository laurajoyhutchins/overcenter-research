import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { validateAdmission } from '../../src/admission.ts';
import type { State, Receipt } from '../../src/facts.ts';
import { claimabilityError } from '../../src/eligibility.ts';
import {
  obligationKey,
  type Lifecycle,
  type RealizationStatus,
} from '../../src/lifecycle.ts';
import type {
  Dependency,
  Obligation,
  Run,
} from '../../src/model.ts';
import {
  effectSemantics,
  verifiedContentIdentity,
} from '../../src/semantics.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmission';

const control=(upstream:string):Dependency=>({kind:'control',upstream});
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

function fileObligation(
  id:string,
  dependencies:Dependency[]=[],
):Obligation {
  return {
    id,
    dependencies,
    packet:{kind:'claim-admission-audition',id},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:`/provider/${id}`,
      content:`content:${id}`,
    },
  };
}

function statusObligation(
  id:string,
  desired:'success'|'failure',
  context='overcenter/audition',
  dependencies:Dependency[]=[],
):Obligation {
  return {
    id,
    dependencies,
    packet:{kind:'claim-admission-audition',id},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context,
      expected_state:desired,
    },
  };
}

function stateOf(...obligations:Obligation[]):State {
  return {
    obligations:Object.fromEntries(obligations.map(obligation=>[obligation.id,obligation])),
    definition_commits:Object.fromEntries(
      obligations.map(obligation=>[obligation.id,`define:${obligation.id}`]),
    ),
  };
}

function fakeRun(obligationId:string):Run {
  return {
    id:`run:${obligationId}`,
    obligation_id:obligationId,
    claimed_revision:'r0',
    claim_commit:`claim:${obligationId}`,
    obligation_key:`key:${obligationId}`,
    execution_generation:1,
    execution_authority_commit:`claim:${obligationId}`,
    execution_capability_sha256:'0'.repeat(64),
  };
}

function lifecyclesFor(
  state:State,
  overrides:Record<string,RealizationStatus>={},
):Map<string,Lifecycle> {
  return new Map(Object.keys(state.obligations).map(id=>{
    const status=overrides[id]??'UNREALIZED';
    return [
      id,
      status==='UNREALIZED'
        ? {status}
        : {status,run:fakeRun(id)},
    ] satisfies [string,Lifecycle];
  }));
}

function semanticIdentity(
  state:State,
  edge:Extract<Dependency,{kind:'semantic'}>,
  lifecycles:Map<string,Lifecycle>,
  receipts:Map<string,Receipt>,
):string|null {
  const upstream=state.obligations[edge.upstream];
  const lifecycle=lifecycles.get(edge.upstream);
  if (!upstream || lifecycle?.status!=='DONE' || !lifecycle.run) return null;

  if (edge.consumes.kind==='output' && edge.consumes.selector==='verified-content') {
    return verifiedContentIdentity(upstream.postcondition);
  }
  if (edge.consumes.kind==='evidence' && edge.consumes.selector==='settlement-receipt') {
    const receipt=receipts.get(lifecycle.run.id);
    if (receipt?.disposition==='DONE' && receipt.settlement_commit) {
      return `settlement:${receipt.settlement_commit}`;
    }
  }
  return null;
}

function leanRequest(
  state:State,
  targetId:string,
  currentRevision:string,
  expectedRevision:string,
  lifecycles:Map<string,Lifecycle>,
  receipts:Map<string,Receipt>,
):unknown {
  return {
    command:'claim-admission',
    current_revision:currentRevision,
    expected_revision:expectedRevision,
    target_id:targetId,
    obligations:Object.values(state.obligations).map(obligation=>({
      id:obligation.id,
      dependencies:obligation.dependencies.map(edge=>({
        upstream:edge.upstream,
        kind:edge.kind,
        semantic_identity:edge.kind==='semantic'
          ? semanticIdentity(state,edge,lifecycles,receipts)
          : null,
      })),
      effect:(()=>{
        const effect=effectSemantics(obligation.postcondition);
        return effect
          ? {
              resource:effect.resource,
              desired:effect.desired,
              same_desired_commutes:effect.sameDesiredCommutes,
            }
          : null;
      })(),
    })),
    lifecycles:Object.values(state.obligations).map(obligation=>({
      obligation_id:obligation.id,
      status:lifecycles.get(obligation.id)?.status??'UNREALIZED',
    })),
  };
}

function leanAdmitted(request:unknown):boolean {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  const response=JSON.parse(stdout) as {
    schema:string;
    admitted:boolean;
  };
  assert.equal(response.schema,'overcenter-lean-claim-admission/v1');
  return response.admitted;
}

function tsAdmitted(
  state:State,
  targetId:string,
  currentRevision:string,
  expectedRevision:string,
  lifecycles:Map<string,Lifecycle>,
  receipts:Map<string,Receipt>,
):boolean {
  try {
    validateAdmission(state);
  } catch {
    return false;
  }
  if (expectedRevision!==currentRevision) return false;
  const target=state.obligations[targetId];
  if (!target) return false;
  if (claimabilityError(state,target,lifecycles)) return false;
  return obligationKey(state,target,lifecycles,receipts)!==null;
}

interface Fixture {
  name:string;
  state:State;
  targetId:string;
  currentRevision?:string;
  expectedRevision?:string;
  lifecycles:Map<string,Lifecycle>;
  receipts?:Map<string,Receipt>;
  expected:boolean;
}

test('Lean and TypeScript agree on fixed hostile claim-admission cases',()=>{
  const leafState=stateOf(fileObligation('leaf'));

  const controlBlockedState=stateOf(
    fileObligation('upstream'),
    fileObligation('target',[control('upstream')]),
  );

  const semanticBlockedState=stateOf(
    fileObligation('upstream'),
    fileObligation('target',[semanticOutput('upstream')]),
  );

  const unresolvedSemanticState=stateOf(
    fileObligation('upstream'),
    fileObligation('target',[semanticReceipt('upstream')]),
  );

  const conflictState=stateOf(
    statusObligation('alpha','success'),
    statusObligation('beta','failure'),
  );

  const commutingState=stateOf(
    statusObligation('alpha','success'),
    statusObligation('beta','success'),
  );

  const orderedState=stateOf(
    statusObligation('alpha','success'),
    statusObligation('beta','failure','overcenter/audition',[control('alpha')]),
  );

  const unrelatedState=stateOf(
    statusObligation('alpha','success','overcenter/audition/a'),
    statusObligation('beta','failure','overcenter/audition/b'),
  );

  const unknownDependencyState=stateOf(
    fileObligation('target',[control('missing')]),
  );

  const cycleState=stateOf(
    fileObligation('alpha',[control('beta')]),
    fileObligation('beta',[control('alpha')]),
  );

  const fixtures:Fixture[]=[
    {
      name:'exact revision, no dependencies, no effect conflict',
      state:leafState,
      targetId:'leaf',
      lifecycles:lifecyclesFor(leafState),
      expected:true,
    },
    {
      name:'stale expected revision',
      state:leafState,
      targetId:'leaf',
      expectedRevision:'stale',
      lifecycles:lifecyclesFor(leafState),
      expected:false,
    },
    {
      name:'target already executing',
      state:leafState,
      targetId:'leaf',
      lifecycles:lifecyclesFor(leafState,{leaf:'EXECUTING'}),
      expected:false,
    },
    {
      name:'target already done',
      state:leafState,
      targetId:'leaf',
      lifecycles:lifecyclesFor(leafState,{leaf:'DONE'}),
      expected:false,
    },
    {
      name:'control dependency not done',
      state:controlBlockedState,
      targetId:'target',
      lifecycles:lifecyclesFor(controlBlockedState),
      expected:false,
    },
    {
      name:'semantic dependency not done',
      state:semanticBlockedState,
      targetId:'target',
      lifecycles:lifecyclesFor(semanticBlockedState),
      expected:false,
    },
    {
      name:'semantic identity unresolved despite done dependency',
      state:unresolvedSemanticState,
      targetId:'target',
      lifecycles:lifecyclesFor(unresolvedSemanticState,{upstream:'DONE'}),
      expected:false,
    },
    {
      name:'unordered incompatible same-resource effects',
      state:conflictState,
      targetId:'beta',
      lifecycles:lifecyclesFor(conflictState,{alpha:'DONE'}),
      expected:false,
    },
    {
      name:'identical commuting same-resource effects',
      state:commutingState,
      targetId:'beta',
      lifecycles:lifecyclesFor(commutingState,{alpha:'DONE'}),
      expected:true,
    },
    {
      name:'incompatible same-resource effects explicitly ordered',
      state:orderedState,
      targetId:'beta',
      lifecycles:lifecyclesFor(orderedState,{alpha:'DONE'}),
      expected:true,
    },
    {
      name:'unrelated effect resources',
      state:unrelatedState,
      targetId:'beta',
      lifecycles:lifecyclesFor(unrelatedState,{alpha:'DONE'}),
      expected:true,
    },
    {
      name:'unknown dependency fails closed',
      state:unknownDependencyState,
      targetId:'target',
      lifecycles:lifecyclesFor(unknownDependencyState),
      expected:false,
    },
    {
      name:'dependency cycle fails closed',
      state:cycleState,
      targetId:'beta',
      lifecycles:lifecyclesFor(cycleState,{alpha:'DONE'}),
      expected:false,
    },
  ];

  for (const fixture of fixtures) {
    const currentRevision=fixture.currentRevision??'r1';
    const expectedRevision=fixture.expectedRevision??'r1';
    const receipts=fixture.receipts??new Map<string,Receipt>();
    const request=leanRequest(
      fixture.state,
      fixture.targetId,
      currentRevision,
      expectedRevision,
      fixture.lifecycles,
      receipts,
    );
    const lean=leanAdmitted(request);
    const typescript=tsAdmitted(
      fixture.state,
      fixture.targetId,
      currentRevision,
      expectedRevision,
      fixture.lifecycles,
      receipts,
    );
    assert.equal(typescript,fixture.expected,`${fixture.name}: TypeScript control`);
    assert.equal(lean,fixture.expected,`${fixture.name}: Lean challenger`);
    assert.equal(lean,typescript,`${fixture.name}: differential`);
  }
});

test('Lean serialized claim-admission boundary rejects malformed semantic facts',()=>{
  const valid={
    command:'claim-admission',
    current_revision:'r1',
    expected_revision:'r1',
    target_id:'leaf',
    obligations:[{
      id:'leaf',
      dependencies:[],
      effect:null,
    }],
    lifecycles:[{
      obligation_id:'leaf',
      status:'MAYBE',
    }],
  };

  assert.throws(
    ()=>execFileSync(kernel,[],{
      input:JSON.stringify(valid),
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    }),
  );

  assert.throws(
    ()=>execFileSync(kernel,[],{
      input:JSON.stringify({...valid,command:'believe-worker'}),
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    }),
  );
});
