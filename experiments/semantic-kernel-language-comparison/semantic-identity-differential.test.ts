import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { validateAdmission } from '../../src/admission.ts';
import { canonicalDigest, sha256 } from '../../src/digest.ts';
import type { Receipt, State } from '../../src/facts.ts';
import { claimabilityError } from '../../src/eligibility.ts';
import {
  obligationKey,
  type Lifecycle,
  type RealizationStatus,
} from '../../src/lifecycle.ts';
import type {
  Dependency,
  Obligation,
  Postcondition,
  Run,
} from '../../src/model.ts';
import {
  effectSemantics,
  verifiedContentIdentity,
} from '../../src/semantics.ts';
import { githubStatusContextKey } from '../../src/providers/github-rest.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterSemanticIdentity';

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

function fileObligation(id:string,dependencies:Dependency[]=[]):Obligation {
  return {
    id,
    dependencies,
    packet:{kind:'semantic-identity-audition',id},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:`/provider/${id}`,
      content:`content:${id}`,
    },
  };
}

function githubObligation(id:string):Obligation {
  return {
    id,
    dependencies:[],
    packet:{kind:'semantic-identity-audition',id},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'OverCenter/CI',
      expected_state:'success',
    },
  };
}

function kubernetesObligation(id:string):Obligation {
  return {
    id,
    dependencies:[],
    packet:{kind:'semantic-identity-audition',id},
    postcondition:{
      verifier:'kubernetes-configmap-exists/v1',
      provider:'kubernetes',
      authority_id:'cluster-a',
      api_group:'',
      resource:'configmaps',
      namespace:'proof',
      name:'config-a',
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

function fakeRun(obligationId:string,id=`run:${obligationId}`):Run {
  return {
    id,
    obligation_id:obligationId,
    claimed_revision:'r0',
    claim_commit:`claim:${id}`,
    obligation_key:`key:${obligationId}`,
    execution_generation:1,
    execution_authority_commit:`claim:${id}`,
    execution_capability_sha256:'0'.repeat(64),
  };
}

function lifecyclesFor(
  state:State,
  overrides:Record<string,RealizationStatus>={},
  runs:Record<string,Run>={},
):Map<string,Lifecycle> {
  return new Map(Object.keys(state.obligations).map(id=>{
    const status=overrides[id]??'UNREALIZED';
    return [
      id,
      status==='UNREALIZED'
        ? {status}
        : {status,run:runs[id]??fakeRun(id)},
    ] satisfies [string,Lifecycle];
  }));
}

function doneReceipt(
  run:Run,
  {
    obligationId=run.obligation_id,
    settlementCommit=`settlement:${run.id}`,
    disposition='DONE' as Receipt['disposition'],
  }={},
):Receipt {
  return {
    schema:'overcenter-git-receipt-v5',
    run_id:run.id,
    obligation_id:obligationId,
    claimed_revision:run.claimed_revision,
    claim_commit:run.claim_commit,
    execution_generation:run.execution_generation,
    execution_authority_commit:run.execution_authority_commit,
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:`/provider/${run.obligation_id}`,
      expected_sha256:sha256(`content:${run.obligation_id}`),
      actual_sha256:sha256(`content:${run.obligation_id}`),
      mutation_certainty:'present',
    },
    settled_at:'2026-09-19T00:00:00.000Z',
    disposition,
    verified:disposition==='DONE',
    ...(settlementCommit?{settlement_commit:settlementCommit}:{}),
  };
}

function semanticSource(postcondition:Postcondition):unknown {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return {
      kind:postcondition.verifier==='file-content-equals/v1'
        ? 'file-content'
        : 'eventually-consistent-file-content',
      content_sha256:sha256(postcondition.content),
    };
  }
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return {
      kind:'github-commit-status',
      repository_id:String(postcondition.repository_id),
      commit_sha:postcondition.commit_sha,
      context:githubStatusContextKey(postcondition.context),
      state:postcondition.expected_state,
    };
  }
  if (postcondition.verifier==='kubernetes-configmap-exists/v1') {
    return {
      kind:'kubernetes-configmap-exists',
      authority_id:postcondition.authority_id,
      api_group:postcondition.api_group,
      resource:postcondition.resource,
      namespace:postcondition.namespace,
      name:postcondition.name,
    };
  }
  return null;
}

function rawRequest(
  state:State,
  targetId:string,
  lifecycles:Map<string,Lifecycle>,
  receipts:Map<string,Receipt>,
):Record<string,unknown> {
  return {
    current_revision:'r1',
    expected_revision:'r1',
    target_id:targetId,
    obligations:Object.values(state.obligations).map(obligation=>({
      id:obligation.id,
      dependencies:obligation.dependencies.map(edge=>({
        upstream:edge.upstream,
        kind:edge.kind,
        selector:edge.kind==='semantic' ? edge.consumes.selector : null,
      })),
      semantic_source:semanticSource(obligation.postcondition),
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
    lifecycles:Object.values(state.obligations).map(obligation=>{
      const lifecycle=lifecycles.get(obligation.id)??{status:'UNREALIZED' as const};
      return {
        obligation_id:obligation.id,
        status:lifecycle.status,
        run_id:lifecycle.run?.id??null,
      };
    }),
    receipts:[...receipts.values()].map(receipt=>({
      run_id:receipt.run_id,
      obligation_id:receipt.obligation_id,
      disposition:receipt.disposition,
      settlement_commit:receipt.settlement_commit??null,
    })),
  };
}

function runKernel(request:Record<string,unknown>):Record<string,unknown> {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(stdout) as Record<string,unknown>;
}

function tsSemanticIdentity(
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
    if (receipt?.disposition!=='DONE' || !receipt.settlement_commit) return null;
    return `settlement:${receipt.settlement_commit}`;
  }
  return null;
}

function encodeLeanIdentityMaterial(value:unknown):string {
  assert.ok(value && typeof value==='object' && !Array.isArray(value));
  const identity=value as Record<string,unknown>;
  if (identity.kind==='settlement-receipt') {
    assert.equal(typeof identity.commit,'string');
    return `settlement:${identity.commit}`;
  }
  assert.equal(identity.kind,'output');
  assert.ok(identity.material && typeof identity.material==='object');
  const material=identity.material as Record<string,unknown>;
  if (material.kind==='content-sha256') {
    assert.equal(typeof material.digest,'string');
    return `sha256:${material.digest}`;
  }
  if (material.kind==='github-commit-status') {
    return canonicalDigest({
      provider:'github',
      repository_id:Number(material.repository_id),
      commit_sha:material.commit_sha,
      context:material.context,
      state:material.state,
    });
  }
  if (material.kind==='kubernetes-exists') {
    return canonicalDigest({
      provider:'kubernetes',
      authority_id:material.authority_id,
      api_group:material.api_group,
      resource:material.resource,
      namespace:material.namespace,
      name:material.name,
      state:'exists',
    });
  }
  throw new Error(`unexpected Lean material: ${JSON.stringify(material)}`);
}

function tsAdmitted(
  state:State,
  targetId:string,
  lifecycles:Map<string,Lifecycle>,
  receipts:Map<string,Receipt>,
):boolean {
  try {
    validateAdmission(state);
  } catch {
    return false;
  }
  const target=state.obligations[targetId];
  if (!target) return false;
  if (claimabilityError(state,target,lifecycles)) return false;
  return obligationKey(state,target,lifecycles,receipts)!==null;
}

test('Lean derives exact semantic identity material for all supported output families and settlement receipts',()=>{
  const providers=[
    fileObligation('upstream-file'),
    githubObligation('upstream-github'),
    kubernetesObligation('upstream-kubernetes'),
  ];

  for (const upstream of providers) {
    const target=fileObligation('target',[semanticOutput(upstream.id)]);
    const state=stateOf(upstream,target);
    const lifecycles=lifecyclesFor(state,{[upstream.id]:'DONE'});
    const receipts=new Map<string,Receipt>();
    const request=rawRequest(state,'target',lifecycles,receipts);
    const response=runKernel({
      command:'semantic-identity',
      ...request,
      upstream:upstream.id,
      selector:'verified-content',
    });
    assert.equal(response.schema,'overcenter-lean-semantic-identity/v1');
    assert.equal(response.resolved,true);
    const edge=target.dependencies[0] as Extract<Dependency,{kind:'semantic'}>;
    assert.equal(
      encodeLeanIdentityMaterial(response.identity_material),
      tsSemanticIdentity(state,edge,lifecycles,receipts),
      upstream.postcondition.verifier,
    );

    const admission=runKernel({command:'claim-admission-derived',...request});
    assert.equal(admission.admitted,tsAdmitted(state,'target',lifecycles,receipts));
    assert.equal(admission.admitted,true);
  }

  const upstream=fileObligation('upstream');
  const target=fileObligation('target',[semanticReceipt('upstream')]);
  const state=stateOf(upstream,target);
  const currentRun=fakeRun('upstream','run-current');
  const lifecycles=lifecyclesFor(state,{upstream:'DONE'},{upstream:currentRun});
  const receipt=doneReceipt(currentRun,{settlementCommit:'receipt-commit-current'});
  const receipts=new Map([[currentRun.id,receipt]]);
  const request=rawRequest(state,'target',lifecycles,receipts);
  const response=runKernel({
    command:'semantic-identity',
    ...request,
    upstream:'upstream',
    selector:'settlement-receipt',
  });
  assert.equal(response.resolved,true);
  const edge=target.dependencies[0] as Extract<Dependency,{kind:'semantic'}>;
  assert.equal(
    encodeLeanIdentityMaterial(response.identity_material),
    tsSemanticIdentity(state,edge,lifecycles,receipts),
  );
  assert.equal(
    runKernel({command:'claim-admission-derived',...request}).admitted,
    tsAdmitted(state,'target',lifecycles,receipts),
  );
});

test('Lean and TypeScript agree when semantic identity is genuinely unresolved',()=>{
  const upstream=fileObligation('upstream');
  const outputTarget=fileObligation('target',[semanticOutput('upstream')]);
  const outputState=stateOf(upstream,outputTarget);
  const outputLifecycles=lifecyclesFor(outputState);
  const emptyReceipts=new Map<string,Receipt>();

  assert.equal(tsAdmitted(outputState,'target',outputLifecycles,emptyReceipts),false);
  assert.equal(
    runKernel({
      command:'claim-admission-derived',
      ...rawRequest(outputState,'target',outputLifecycles,emptyReceipts),
    }).admitted,
    false,
  );

  const evidenceTarget=fileObligation('target',[semanticReceipt('upstream')]);
  const evidenceState=stateOf(upstream,evidenceTarget);
  const currentRun=fakeRun('upstream','run-current');
  const evidenceLifecycles=lifecyclesFor(
    evidenceState,
    {upstream:'DONE'},
    {upstream:currentRun},
  );

  const staleRun=fakeRun('upstream','run-old');
  const staleReceipts=new Map([[staleRun.id,doneReceipt(staleRun)]]);
  assert.equal(tsAdmitted(evidenceState,'target',evidenceLifecycles,staleReceipts),false);
  assert.equal(
    runKernel({
      command:'claim-admission-derived',
      ...rawRequest(evidenceState,'target',evidenceLifecycles,staleReceipts),
    }).admitted,
    false,
  );

  const nonDone=new Map([
    [currentRun.id,doneReceipt(currentRun,{disposition:'READY'})],
  ]);
  assert.equal(tsAdmitted(evidenceState,'target',evidenceLifecycles,nonDone),false);
  assert.equal(
    runKernel({
      command:'claim-admission-derived',
      ...rawRequest(evidenceState,'target',evidenceLifecycles,nonDone),
    }).admitted,
    false,
  );

  const missingSettlement=new Map([
    [currentRun.id,doneReceipt(currentRun,{settlementCommit:''})],
  ]);
  assert.equal(tsAdmitted(evidenceState,'target',evidenceLifecycles,missingSettlement),false);
  assert.equal(
    runKernel({
      command:'claim-admission-derived',
      ...rawRequest(evidenceState,'target',evidenceLifecycles,missingSettlement),
    }).admitted,
    false,
  );
});

test('Lean raw-facts boundary rejects facts that TypeScript replay already forbids',()=>{
  const upstream=fileObligation('upstream');
  const target=fileObligation('target',[semanticReceipt('upstream')]);
  const state=stateOf(upstream,target);
  const currentRun=fakeRun('upstream','run-current');
  const lifecycles=lifecyclesFor(state,{upstream:'DONE'},{upstream:currentRun});
  const validReceipt=doneReceipt(currentRun,{settlementCommit:'receipt-current'});
  const base=rawRequest(
    state,
    'target',
    lifecycles,
    new Map([[currentRun.id,validReceipt]]),
  );

  const wrongObligation=structuredClone(base);
  (wrongObligation.receipts as Array<Record<string,unknown>>)[0].obligation_id='other';
  assert.equal(
    runKernel({command:'claim-admission-derived',...wrongObligation}).admitted,
    false,
  );

  const duplicateReceipt=structuredClone(base);
  (duplicateReceipt.receipts as unknown[]).push(
    structuredClone((duplicateReceipt.receipts as unknown[])[0]),
  );
  assert.equal(
    runKernel({command:'claim-admission-derived',...duplicateReceipt}).admitted,
    false,
  );

  const missingOutputState=stateOf(
    fileObligation('source'),
    fileObligation('target',[semanticOutput('source')]),
  );
  const missingOutputLifecycles=lifecyclesFor(missingOutputState,{source:'DONE'});
  const missingOutput=rawRequest(
    missingOutputState,
    'target',
    missingOutputLifecycles,
    new Map(),
  );
  const source=(missingOutput.obligations as Array<Record<string,unknown>>)
    .find(item=>item.id==='source');
  assert.ok(source);
  source.semantic_source=null;
  assert.equal(
    runKernel({command:'claim-admission-derived',...missingOutput}).admitted,
    false,
  );
});

test('caller cannot smuggle a precomputed semantic identity across the Lean boundary',()=>{
  const upstream=fileObligation('upstream');
  const target=fileObligation('target',[semanticReceipt('upstream')]);
  const state=stateOf(upstream,target);
  const currentRun=fakeRun('upstream','run-current');
  const lifecycles=lifecyclesFor(state,{upstream:'DONE'},{upstream:currentRun});
  const request=rawRequest(state,'target',lifecycles,new Map());
  const dependencies=(
    (request.obligations as Array<Record<string,unknown>>)
      .find(item=>item.id==='target')?.dependencies
  ) as Array<Record<string,unknown>>;
  dependencies[0].semantic_identity='forged-success';

  assert.throws(
    ()=>runKernel({command:'claim-admission-derived',...request}),
  );

  const unsupported=rawRequest(state,'target',lifecycles,new Map());
  const unsupportedDependencies=(
    (unsupported.obligations as Array<Record<string,unknown>>)
      .find(item=>item.id==='target')?.dependencies
  ) as Array<Record<string,unknown>>;
  unsupportedDependencies[0].selector='ambient-state';

  assert.throws(
    ()=>runKernel({command:'claim-admission-derived',...unsupported}),
  );
});
