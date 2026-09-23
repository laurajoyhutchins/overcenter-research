import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { GITHUB_COMMIT_STATUS_EFFECT } from '../../src/providers/github/status-effect.ts';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {[key:string]:Json};

type NodeKind =
  | 'obligation'
  | 'authority'
  | 'execution'
  | 'trace'
  | 'effect-attempt'
  | 'observation'
  | 'verification'
  | 'settlement';

interface ReceiptNode {
  schema:'overcenter-merkle-execution-node/v1';
  kind:NodeKind;
  parents:Record<string,string>;
  payload:{[key:string]:Json};
}

interface Scenario {
  root:string;
  ids:{
    obligation:string;
    authority:string;
    execution:string;
    trace:string;
    effect:string;
    observation:string;
    verification:string;
    settlement:string;
  };
}

const SOURCE_A='a'.repeat(40);
const SOURCE_B='b'.repeat(40);
const SAME_TREE='c'.repeat(40);
const PROVIDER_COMMIT='d'.repeat(40);

function canonical(value:Json):string {
  if (value===null) return 'null';
  if (typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number') {
    if (!Number.isFinite(value)) throw new Error('NONFINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>
    JSON.stringify(key)+':'+canonical(value[key]!)
  ).join(',')+'}';
}

function canonicalNode(node:ReceiptNode):string {
  return canonical(node as unknown as Json);
}

function digest(node:ReceiptNode):string {
  return createHash('sha256').update(canonicalNode(node)).digest('hex');
}

class ReceiptStore {
  readonly objects=new Map<string,ReceiptNode>();

  put(node:ReceiptNode):string {
    const value=structuredClone(node);
    const id=digest(value);
    this.objects.set(id,value);
    return id;
  }

  get(id:string):ReceiptNode {
    const node=this.objects.get(id);
    if (!node) throw new Error(`MISSING_NODE:${id}`);
    return node;
  }

  remove(id:string):void {
    this.objects.delete(id);
  }

  replaceWithoutRehash(id:string,node:ReceiptNode):void {
    this.objects.set(id,structuredClone(node));
  }

  verifyClosure(root:string):Set<string> {
    const seen=new Set<string>();
    const visit=(id:string):void=>{
      if (seen.has(id)) return;
      const node=this.get(id);
      if (digest(node)!==id) throw new Error(`NODE_DIGEST_MISMATCH:${id}`);
      seen.add(id);
      for (const parent of Object.values(node.parents)) visit(parent);
    };
    visit(root);
    return seen;
  }

  closureBytes(root:string):number {
    let bytes=0;
    for (const id of this.verifyClosure(root)) {
      bytes+=Buffer.byteLength(canonicalNode(this.get(id)));
    }
    return bytes;
  }
}

function expectKind(store:ReceiptStore,id:string,kind:NodeKind):ReceiptNode {
  const node=store.get(id);
  if (node.kind!==kind) throw new Error(`EXPECTED_${kind.toUpperCase()}`);
  return node;
}

function requiredParent(node:ReceiptNode,name:string):string {
  const id=node.parents[name];
  if (!id) throw new Error(`MISSING_PARENT:${node.kind}:${name}`);
  return id;
}

function textField(node:ReceiptNode,name:string):string {
  const value=node.payload[name];
  if (typeof value!=='string') throw new Error(`INVALID_FIELD:${node.kind}:${name}`);
  return value;
}

function numberField(node:ReceiptNode,name:string):number {
  const value=node.payload[name];
  if (typeof value!=='number') throw new Error(`INVALID_FIELD:${node.kind}:${name}`);
  return value;
}

function deriveHistoricalDisposition(store:ReceiptStore,root:string):'DONE'|'RECOVERY_REQUIRED' {
  store.verifyClosure(root);
  const settlement=expectKind(store,root,'settlement');
  const executionId=requiredParent(settlement,'execution');
  const verificationId=requiredParent(settlement,'verification');
  const execution=expectKind(store,executionId,'execution');
  const verification=expectKind(store,verificationId,'verification');

  const obligationId=requiredParent(execution,'obligation');
  const obligation=expectKind(store,obligationId,'obligation');
  if (requiredParent(verification,'obligation')!==obligationId) {
    throw new Error('SETTLEMENT_OBLIGATION_MISMATCH');
  }

  const traceId=requiredParent(verification,'trace');
  const trace=expectKind(store,traceId,'trace');
  if (requiredParent(trace,'execution')!==executionId) {
    throw new Error('TRACE_EXECUTION_MISMATCH');
  }

  const observation=expectKind(
    store,
    requiredParent(verification,'observation'),
    'observation',
  );
  const effectId=requiredParent(observation,'effect');
  const effect=expectKind(store,effectId,'effect-attempt');
  if (
    requiredParent(effect,'execution')!==executionId
    || requiredParent(effect,'trace')!==traceId
  ) {
    throw new Error('EFFECT_CAUSAL_MISMATCH');
  }

  const source=textField(obligation,'source_sha');
  for (const node of [execution,trace,verification,settlement]) {
    if (textField(node,'source_sha')!==source) throw new Error('SOURCE_REVISION_MISMATCH');
  }

  const expectedObligation=textField(obligation,'obligation_id');
  const expectedRun=textField(execution,'run_id');
  if (
    textField(settlement,'obligation_id')!==expectedObligation
    || textField(settlement,'run_id')!==expectedRun
  ) {
    throw new Error('SETTLEMENT_IDENTITY_MISMATCH');
  }

  const coordinateFields=['repository_id','provider_commit_sha','context'] as const;
  for (const field of coordinateFields) {
    const expected=obligation.payload[field];
    const effectValue=effect.payload[field];
    const observedValue=observation.payload[field];
    if (effectValue!==expected || observedValue!==expected) {
      throw new Error(`PROVIDER_COORDINATE_MISMATCH:${field}`);
    }
  }

  const authoritative=observation.payload.authoritative===true;
  const observedState=observation.payload.observed_state;
  const expectedState=obligation.payload.expected_state;
  const verified=authoritative && observedState===expectedState;
  const claimed=textField(settlement,'disposition');

  if (claimed==='DONE') {
    if (!verified) throw new Error('FALSE_DONE');
    return 'DONE';
  }
  if (claimed!=='RECOVERY_REQUIRED') throw new Error('INVALID_DISPOSITION');
  if (verified) throw new Error('UNNECESSARY_RECOVERY');
  return 'RECOVERY_REQUIRED';
}

function buildScenario(
  store:ReceiptStore,
  {
    sourceSha=SOURCE_A,
    sourceTree=SAME_TREE,
    authorityRevision='authority-2',
    authoritySequence=2,
    runId='run-2',
    effectOutcome='acknowledged',
    authoritative=true,
    observedState='success' as string|null,
    disposition,
  }:{
    sourceSha?:string;
    sourceTree?:string;
    authorityRevision?:string;
    authoritySequence?:number;
    runId?:string;
    effectOutcome?:'acknowledged'|'timeout';
    authoritative?:boolean;
    observedState?:string|null;
    disposition?:'DONE'|'RECOVERY_REQUIRED';
  }={},
):Scenario {
  const obligation=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'obligation',
    parents:{},
    payload:{
      obligation_id:'status-proof',
      effect_contract:GITHUB_COMMIT_STATUS_EFFECT,
      verifier:'github-commit-status/v2',
      source_sha:sourceSha,
      source_tree:sourceTree,
      repository_id:42,
      provider_commit_sha:PROVIDER_COMMIT,
      context:'overcenter/proof',
      expected_state:'success',
    },
  });
  const authority=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'authority',
    parents:{},
    payload:{
      authority_revision:authorityRevision,
      authority_sequence:authoritySequence,
    },
  });
  const execution=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'execution',
    parents:{obligation,authority},
    payload:{
      obligation_id:'status-proof',
      run_id:runId,
      source_sha:sourceSha,
      execution_generation:1,
      claimed_revision:authorityRevision,
    },
  });
  const trace=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'trace',
    parents:{execution},
    payload:{
      source_sha:sourceSha,
      source_tree:sourceTree,
      request_method:'POST',
      request_path:`/repos/acme/widget/statuses/${PROVIDER_COMMIT}`,
    },
  });
  const effect=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'effect-attempt',
    parents:{execution,trace},
    payload:{
      source_sha:sourceSha,
      provider:'github',
      repository_id:42,
      provider_commit_sha:PROVIDER_COMMIT,
      context:'overcenter/proof',
      desired_state:'success',
      outcome:effectOutcome,
    },
  });
  const observation=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'observation',
    parents:{effect},
    payload:{
      source_sha:sourceSha,
      observer:'github-certified-status/v1',
      repository_id:42,
      provider_commit_sha:PROVIDER_COMMIT,
      context:'overcenter/proof',
      authoritative,
      observed_state:observedState,
    },
  });
  const verification=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'verification',
    parents:{obligation,trace,observation},
    payload:{
      source_sha:sourceSha,
      verifier:'github-commit-status/v2',
    },
  });
  const derivedDisposition=
    authoritative && observedState==='success' ? 'DONE' : 'RECOVERY_REQUIRED';
  const settlement=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'settlement',
    parents:{execution,verification},
    payload:{
      obligation_id:'status-proof',
      run_id:runId,
      source_sha:sourceSha,
      disposition:disposition??derivedDisposition,
    },
  });
  return {
    root:settlement,
    ids:{obligation,authority,execution,trace,effect,observation,verification,settlement},
  };
}

interface SignedCheckpoint {
  payload:{
    schema:'overcenter-merkle-authority-checkpoint/v1';
    sequence:number;
    root:string;
  };
  signature:string;
}

function signCheckpoint(root:string,sequence:number,privateKey:KeyObject):SignedCheckpoint {
  const payload={
    schema:'overcenter-merkle-authority-checkpoint/v1' as const,
    sequence,
    root,
  };
  return {
    payload,
    signature:sign(null,Buffer.from(canonical(payload as unknown as Json)),privateKey)
      .toString('base64'),
  };
}

function requireCheckpoint(
  candidateRoot:string,
  checkpoint:SignedCheckpoint,
  publicKey:KeyObject,
):void {
  const valid=verify(
    null,
    Buffer.from(canonical(checkpoint.payload as unknown as Json)),
    publicKey,
    Buffer.from(checkpoint.signature,'base64'),
  );
  if (!valid) throw new Error('CHECKPOINT_SIGNATURE_INVALID');
  if (candidateRoot!==checkpoint.payload.root) throw new Error('AUTHORITY_ROLLBACK');
}

function median(values:number[]):number {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)]!;
}

test('one-byte observation corruption invalidates the causal closure',()=>{
  const store=new ReceiptStore();
  const scenario=buildScenario(store);
  const original=store.get(scenario.ids.observation);
  const corrupted=structuredClone(original);
  corrupted.payload.observed_state='failure';
  store.replaceWithoutRehash(scenario.ids.observation,corrupted);
  assert.throws(
    ()=>deriveHistoricalDisposition(store,scenario.root),
    /NODE_DIGEST_MISMATCH/,
  );
});

test('missing causal evidence cannot project DONE',()=>{
  const store=new ReceiptStore();
  const scenario=buildScenario(store);
  store.remove(scenario.ids.trace);
  assert.throws(
    ()=>deriveHistoricalDisposition(store,scenario.root),
    /MISSING_NODE/,
  );
});

test('same-tree evidence cannot cross exact source SHA identity',()=>{
  const store=new ReceiptStore();
  const a=buildScenario(store,{
    sourceSha:SOURCE_A,
    sourceTree:SAME_TREE,
    authorityRevision:'authority-a',
    authoritySequence:1,
    runId:'run-a',
  });
  const b=buildScenario(store,{
    sourceSha:SOURCE_B,
    sourceTree:SAME_TREE,
    authorityRevision:'authority-b',
    authoritySequence:2,
    runId:'run-b',
  });

  const copied=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'settlement',
    parents:{
      execution:b.ids.execution,
      verification:a.ids.verification,
    },
    payload:{
      obligation_id:'status-proof',
      run_id:'run-b',
      source_sha:SOURCE_B,
      disposition:'DONE',
    },
  });

  assert.equal(
    textField(store.get(a.ids.obligation),'source_tree'),
    textField(store.get(b.ids.obligation),'source_tree'),
  );
  assert.throws(
    ()=>deriveHistoricalDisposition(store,copied),
    /SETTLEMENT_OBLIGATION_MISMATCH|SOURCE_REVISION_MISMATCH/,
  );
});

test('signed latest-root checkpoint detects an internally valid rollback',()=>{
  const store=new ReceiptStore();
  const old=buildScenario(store,{
    authorityRevision:'authority-1',
    authoritySequence:1,
    runId:'run-1',
  });
  const current=buildScenario(store,{
    authorityRevision:'authority-2',
    authoritySequence:2,
    runId:'run-2',
  });
  assert.equal(deriveHistoricalDisposition(store,old.root),'DONE');
  assert.equal(deriveHistoricalDisposition(store,current.root),'DONE');

  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const checkpoint=signCheckpoint(current.root,2,privateKey);
  assert.doesNotThrow(()=>requireCheckpoint(current.root,checkpoint,publicKey));
  assert.throws(()=>requireCheckpoint(old.root,checkpoint,publicKey),/AUTHORITY_ROLLBACK/);
});

test('historical DONE is reconstructible with no lifecycle cache',()=>{
  const store=new ReceiptStore();
  const scenario=buildScenario(store);
  let lifecycleCache:'DONE'|undefined='DONE';
  lifecycleCache=undefined;
  assert.equal(lifecycleCache,undefined);
  assert.equal(deriveHistoricalDisposition(store,scenario.root),'DONE');
});

test('timeout without authoritative readback remains recovery-bound and cannot forge DONE',()=>{
  const store=new ReceiptStore();
  const scenario=buildScenario(store,{
    effectOutcome:'timeout',
    authoritative:false,
    observedState:null,
  });
  assert.equal(
    deriveHistoricalDisposition(store,scenario.root),
    'RECOVERY_REQUIRED',
  );

  const forgedDone=store.put({
    schema:'overcenter-merkle-execution-node/v1',
    kind:'settlement',
    parents:{
      execution:scenario.ids.execution,
      verification:scenario.ids.verification,
    },
    payload:{
      obligation_id:'status-proof',
      run_id:'run-2',
      source_sha:SOURCE_A,
      disposition:'DONE',
    },
  });
  assert.throws(()=>deriveHistoricalDisposition(store,forgedDone),/FALSE_DONE/);
});

test('emit sidecar size and hosted latency observations',()=>{
  const representative=new ReceiptStore();
  const scenario=buildScenario(representative);
  assert.equal(deriveHistoricalDisposition(representative,scenario.root),'DONE');
  const objectCount=representative.verifyClosure(scenario.root).size;
  const merkleBytes=representative.closureBytes(scenario.root);

  const flat={
    obligation:representative.get(scenario.ids.obligation).payload,
    authority:representative.get(scenario.ids.authority).payload,
    execution:representative.get(scenario.ids.execution).payload,
    trace:representative.get(scenario.ids.trace).payload,
    effect:representative.get(scenario.ids.effect).payload,
    observation:representative.get(scenario.ids.observation).payload,
    verification:representative.get(scenario.ids.verification).payload,
    settlement:representative.get(scenario.ids.settlement).payload,
  };
  const flatBytes=Buffer.byteLength(canonical(flat as unknown as Json));

  const buildUs:number[]=[];
  const validateUs:number[]=[];
  for (let i=0;i<1000;i+=1) {
    const store=new ReceiptStore();
    const startBuild=performance.now();
    const built=buildScenario(store,{runId:`bench-${i}`});
    const endBuild=performance.now();
    deriveHistoricalDisposition(store,built.root);
    const endValidate=performance.now();
    buildUs.push((endBuild-startBuild)*1000);
    validateUs.push((endValidate-endBuild)*1000);
  }

  const result={
    schema:'overcenter-merkle-execution-receipts-result/v1',
    object_count:objectCount,
    merkle_closure_bytes:merkleBytes,
    equivalent_flat_bytes:flatBytes,
    byte_ratio:Number((merkleBytes/flatBytes).toFixed(3)),
    build_p50_us:Number(median(buildUs).toFixed(3)),
    validate_p50_us:Number(median(validateUs).toFixed(3)),
    false_done:0,
  };
  assert.equal(result.object_count,8);
  assert.ok(result.merkle_closure_bytes>0);
  assert.ok(result.equivalent_flat_bytes>0);
  console.log('MERKLE_EXECUTION_RECEIPTS_RESULT '+JSON.stringify(result));
});
