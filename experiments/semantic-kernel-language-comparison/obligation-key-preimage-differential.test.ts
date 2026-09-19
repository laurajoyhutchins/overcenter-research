import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { sha256 } from '../../src/digest.ts';
import type { Receipt, State } from '../../src/facts.ts';
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
import { githubStatusContextKey } from '../../src/providers/github-rest.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterObligationKeyPreimage';

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

function obligation(
  id:string,
  postcondition:Postcondition,
  dependencies:Dependency[]=[],
  packet:Record<string,unknown>={kind:'key-preimage-audition',id},
):Obligation {
  return {id,dependencies,packet,postcondition};
}

function filePostcondition(id:string):Postcondition {
  return {
    verifier:'file-content-equals/v1',
    path:`/provider/${id}`,
    content:`content:${id}`,
  };
}

function eventualPostcondition(id:string):Postcondition {
  return {
    verifier:'eventually-consistent-file-content-equals/v1',
    path:`/provider/${id}`,
    content:`content:${id}`,
  };
}

function githubV1Postcondition():Postcondition {
  return {
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id:123,
    commit_sha:'a'.repeat(40),
    context:'OverCenter/CI',
    expected_state:'success',
  };
}

function githubV2Postcondition():Postcondition {
  return {
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:123,
    repository_full_name:'Owner/Repo',
    commit_sha:'b'.repeat(40),
    context:'OverCenter/Deploy',
    expected_state:'pending',
  };
}

function kubernetesPostcondition():Postcondition {
  return {
    verifier:'kubernetes-configmap-exists/v1',
    provider:'kubernetes',
    authority_id:'cluster-a',
    api_group:'',
    resource:'configmaps',
    namespace:'proof',
    name:'config-a',
  };
}

function stateOf(...obligations:Obligation[]):State {
  return {
    obligations:Object.fromEntries(obligations.map(item=>[item.id,item])),
    definition_commits:Object.fromEntries(
      obligations.map(item=>[item.id,`define:${item.id}`]),
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

function doneReceipt(run:Run,settlementCommit=`settlement:${run.id}`):Receipt {
  return {
    schema:'overcenter-git-receipt-v5',
    run_id:run.id,
    obligation_id:run.obligation_id,
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
    disposition:'DONE',
    verified:true,
    settlement_commit:settlementCommit,
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
  const target=state.obligations[targetId];
  assert.ok(target);
  return {
    current_revision:'r1',
    expected_revision:'r1',
    target_id:targetId,
    packet:target.packet,
    postcondition:target.postcondition,
    obligations:Object.values(state.obligations).map(item=>({
      id:item.id,
      dependencies:item.dependencies.map(edge=>({
        upstream:edge.upstream,
        kind:edge.kind,
        selector:edge.kind==='semantic' ? edge.consumes.selector : null,
      })),
      semantic_source:semanticSource(item.postcondition),
    })),
    lifecycles:Object.values(state.obligations).map(item=>{
      const lifecycle=lifecycles.get(item.id)??{status:'UNREALIZED' as const};
      return {
        obligation_id:item.id,
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

function leanPreimage(
  request:Record<string,unknown>,
):{preimage:string;key:string;hashRequests:string[]}|null {
  const plan=runKernel({command:'key-hash-plan',...request});
  assert.equal(plan.schema,'overcenter-lean-obligation-key-preimage/v1');
  if (plan.accepted!==true) return null;
  const hashRequests=(plan.hash_requests as Array<{bytes:string}>).map(item=>item.bytes);
  const hashResults=hashRequests.map(bytes=>({bytes,digest:sha256(bytes)}));
  const response=runKernel({
    command:'key-preimage',
    ...request,
    hash_results:hashResults,
  });
  assert.equal(response.schema,'overcenter-lean-obligation-key-preimage/v1');
  if (response.accepted!==true) return null;
  assert.equal(typeof response.preimage_json,'string');
  const preimage=response.preimage_json as string;
  return {preimage,key:sha256(preimage),hashRequests};
}

function tsKey(
  state:State,
  targetId:string,
  lifecycles:Map<string,Lifecycle>,
  receipts:Map<string,Receipt>,
):string|null {
  return obligationKey(
    state,
    state.obligations[targetId],
    lifecycles,
    receipts,
  );
}

test('Lean constructs exact current obligation-key bytes for every postcondition family',()=>{
  const postconditions:Postcondition[]=[
    filePostcondition('target'),
    eventualPostcondition('target'),
    githubV1Postcondition(),
    githubV2Postcondition(),
    kubernetesPostcondition(),
  ];

  for (const postcondition of postconditions) {
    const target=obligation(
      'target',
      postcondition,
      [],
      {
        kind:'key-preimage-audition',
        nested:{z:1,a:2},
        array:[3,2,1],
        bool:true,
        nil:null,
        integer:42,
        empty:'',
        escaped:'line\n"quote"\\slash',
        unicode:'λ雪',
      },
    );
    const state=stateOf(target);
    const lifecycles=lifecyclesFor(state);
    const receipts=new Map<string,Receipt>();
    const lean=leanPreimage(rawRequest(state,'target',lifecycles,receipts));
    assert.ok(lean,postcondition.verifier);
    assert.equal(lean.key,tsKey(state,'target',lifecycles,receipts),postcondition.verifier);
  }
});

test('Lean composes file, GitHub, Kubernetes, and settlement semantic identities before final hashing',()=>{
  const file=obligation('file',filePostcondition('file'));
  const github=obligation('github',githubV1Postcondition());
  const kube=obligation('kube',kubernetesPostcondition());
  const receiptSource=obligation('receipt',filePostcondition('receipt'));
  const target=obligation(
    'target',
    filePostcondition('target'),
    [
      semanticOutput('file'),
      semanticOutput('github'),
      semanticOutput('kube'),
      semanticReceipt('receipt'),
    ],
  );
  const state=stateOf(file,github,kube,receiptSource,target);
  const receiptRun=fakeRun('receipt','run-receipt-current');
  const lifecycles=lifecyclesFor(
    state,
    {file:'DONE',github:'DONE',kube:'DONE',receipt:'DONE'},
    {receipt:receiptRun},
  );
  const receipts=new Map([
    [receiptRun.id,doneReceipt(receiptRun,'receipt-commit-current')],
  ]);

  const lean=leanPreimage(rawRequest(state,'target',lifecycles,receipts));
  assert.ok(lean);
  assert.equal(lean.key,tsKey(state,'target',lifecycles,receipts));
  assert.equal(lean.hashRequests.length,2,'GitHub and Kubernetes identities require nested hashes');
  assert.ok(lean.hashRequests.every(bytes=>bytes.startsWith('{') && bytes.endsWith('}')));
});

test('semantic dependency declaration order does not change canonical preimage bytes',()=>{
  const left=obligation('left',filePostcondition('left'));
  const right=obligation('right',githubV1Postcondition());
  const targetA=obligation(
    'target',
    filePostcondition('target'),
    [semanticOutput('left'),semanticOutput('right')],
  );
  const targetB=obligation(
    'target',
    filePostcondition('target'),
    [semanticOutput('right'),semanticOutput('left')],
  );

  const stateA=stateOf(left,right,targetA);
  const stateB=stateOf(left,right,targetB);
  const lifecyclesA=lifecyclesFor(stateA,{left:'DONE',right:'DONE'});
  const lifecyclesB=lifecyclesFor(stateB,{left:'DONE',right:'DONE'});
  const receipts=new Map<string,Receipt>();

  const a=leanPreimage(rawRequest(stateA,'target',lifecyclesA,receipts));
  const b=leanPreimage(rawRequest(stateB,'target',lifecyclesB,receipts));
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.preimage,b.preimage);
  assert.equal(a.key,b.key);
  assert.equal(a.key,tsKey(stateA,'target',lifecyclesA,receipts));
  assert.equal(b.key,tsKey(stateB,'target',lifecyclesB,receipts));
});

test('same upstream may contribute distinct output and settlement selectors',()=>{
  const source=obligation('source',filePostcondition('source'));
  const target=obligation(
    'target',
    filePostcondition('target'),
    [semanticOutput('source'),semanticReceipt('source')],
  );
  const state=stateOf(source,target);
  const sourceRun=fakeRun('source','run-source-current');
  const lifecycles=lifecyclesFor(state,{source:'DONE'},{source:sourceRun});
  const receipts=new Map([
    [sourceRun.id,doneReceipt(sourceRun,'source-settlement')],
  ]);
  const lean=leanPreimage(rawRequest(state,'target',lifecycles,receipts));
  assert.ok(lean);
  assert.equal(lean.key,tsKey(state,'target',lifecycles,receipts));
});

test('nested packet object insertion order is erased while array order remains material',()=>{
  const packetA={
    outer:{z:3,a:1,m:2},
    sequence:[{z:2,a:1},'x',false,null],
  };
  const packetB={
    sequence:[{a:1,z:2},'x',false,null],
    outer:{m:2,a:1,z:3},
  };
  const packetC={
    outer:{z:3,a:1,m:2},
    sequence:[null,false,'x',{a:1,z:2}],
  };

  const make=(packet:Record<string,unknown>)=>{
    const target=obligation('target',filePostcondition('target'),[],packet);
    const state=stateOf(target);
    const lifecycles=lifecyclesFor(state);
    return {state,lifecycles,lean:leanPreimage(rawRequest(state,'target',lifecycles,new Map()))};
  };

  const a=make(packetA);
  const b=make(packetB);
  const c=make(packetC);
  assert.ok(a.lean);
  assert.ok(b.lean);
  assert.ok(c.lean);
  assert.equal(a.lean.preimage,b.lean.preimage);
  assert.equal(a.lean.key,b.lean.key);
  assert.notEqual(a.lean.key,c.lean.key);
  assert.equal(a.lean.key,tsKey(a.state,'target',a.lifecycles,new Map()));
  assert.equal(b.lean.key,tsKey(b.state,'target',b.lifecycles,new Map()));
  assert.equal(c.lean.key,tsKey(c.state,'target',c.lifecycles,new Map()));
});

test('Unicode object-key ordering is part of the portability audition',()=>{
  const target=obligation(
    'target',
    filePostcondition('target'),
    [],
    {
      z:1,
      'ä':2,
      A:3,
      'Ω':4,
      nested:{'雪':1,y:2,'é':3},
    },
  );
  const state=stateOf(target);
  const lifecycles=lifecyclesFor(state);
  const lean=leanPreimage(rawRequest(state,'target',lifecycles,new Map()));
  assert.ok(lean);
  assert.equal(
    lean.key,
    tsKey(state,'target',lifecycles,new Map()),
    'canonical key bytes must not depend on language-specific object-key ordering',
  );
});

test('duplicate exact semantic edges fail closed at the Lean preimage boundary',()=>{
  const source=obligation('source',filePostcondition('source'));
  const target=obligation(
    'target',
    filePostcondition('target'),
    [semanticOutput('source'),semanticOutput('source')],
  );
  const state=stateOf(source,target);
  const lifecycles=lifecyclesFor(state,{source:'DONE'});
  const receipts=new Map<string,Receipt>();
  const lean=leanPreimage(rawRequest(state,'target',lifecycles,receipts));
  assert.equal(lean,null);
  assert.ok(
    tsKey(state,'target',lifecycles,receipts),
    'current TypeScript key still exposes duplicate-edge syntax sensitivity',
  );
});

test('unresolved semantic dependencies produce no preimage',()=>{
  const source=obligation('source',filePostcondition('source'));
  const target=obligation(
    'target',
    filePostcondition('target'),
    [semanticOutput('source')],
  );
  const state=stateOf(source,target);
  const lifecycles=lifecyclesFor(state);
  assert.equal(
    leanPreimage(rawRequest(state,'target',lifecycles,new Map())),
    null,
  );
  assert.equal(tsKey(state,'target',lifecycles,new Map()),null);
});

test('unsupported selectors and caller-provided key material are rejected',()=>{
  const source=obligation('source',filePostcondition('source'));
  const badDependency={
    kind:'semantic',
    upstream:'source',
    consumes:{kind:'output',selector:'ambient-state'},
  } as unknown as Dependency;
  const target=obligation(
    'target',
    filePostcondition('target'),
    [badDependency],
  );
  const state=stateOf(source,target);
  const lifecycles=lifecyclesFor(state,{source:'DONE'});
  const request=rawRequest(state,'target',lifecycles,new Map());

  assert.throws(()=>leanPreimage(request));

  const validTarget=obligation('target',filePostcondition('target'));
  const validState=stateOf(validTarget);
  const validRequest=rawRequest(
    validState,
    'target',
    lifecyclesFor(validState),
    new Map(),
  );

  assert.throws(()=>runKernel({
    command:'key-hash-plan',
    ...validRequest,
    preimage_json:'forged',
  }));
  assert.throws(()=>runKernel({
    command:'key-hash-plan',
    ...validRequest,
    obligation_key:'forged',
  }));
  assert.throws(()=>runKernel({
    command:'key-hash-plan',
    ...validRequest,
    semantic_dependencies_sorted:[],
  }));
});

test('hash oracle responses are authority-bound to the exact Lean plan',()=>{
  const github=obligation('github',githubV1Postcondition());
  const target=obligation(
    'target',
    filePostcondition('target'),
    [semanticOutput('github')],
  );
  const state=stateOf(github,target);
  const lifecycles=lifecyclesFor(state,{github:'DONE'});
  const request=rawRequest(state,'target',lifecycles,new Map());
  const plan=runKernel({command:'key-hash-plan',...request});
  assert.equal(plan.accepted,true);
  const [{bytes}]=plan.hash_requests as Array<{bytes:string}>;

  const missing=runKernel({
    command:'key-preimage',
    ...request,
    hash_results:[],
  });
  assert.equal(missing.accepted,false);

  const extra=runKernel({
    command:'key-preimage',
    ...request,
    hash_results:[
      {bytes,digest:sha256(bytes)},
      {bytes:'not-requested',digest:sha256('not-requested')},
    ],
  });
  assert.equal(extra.accepted,false);

  const duplicate=runKernel({
    command:'key-preimage',
    ...request,
    hash_results:[
      {bytes,digest:sha256(bytes)},
      {bytes,digest:sha256(bytes)},
    ],
  });
  assert.equal(duplicate.accepted,false);
});
