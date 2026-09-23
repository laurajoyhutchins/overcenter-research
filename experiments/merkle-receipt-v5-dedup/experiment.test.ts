import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import {
  obligationDefinition,
  materializeObligation,
  validateReceiptFact,
  type ObligationDefinition,
  type Receipt,
  type ReceiptFact,
} from '../../src/authority/facts.ts';
import { projectReceipt } from '../../src/authority/replay.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';
import type { GithubJsonGet } from '../../src/providers/github/rest.ts';
import type { Data, Obligation } from '../../src/model.ts';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {[key:string]:Json};

interface MerkleNode {
  schema:'overcenter-merkle-receipt-v5-node/v1';
  kind:'definition'|'observation'|'execution'|'settlement';
  parents:Record<string,string>;
  payload:{[key:string]:Json};
}

interface Encoded {
  root:string;
  definition:string;
  observation:string|null;
  execution:string;
}

const COMMIT='a'.repeat(40);
const FIXED_TIME='2026-09-23T04:00:00.000Z';

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

function cleanRecord(value:Record<string,unknown>):Record<string,Json> {
  const result:Record<string,Json>={};
  for (const [key,item] of Object.entries(value)) {
    if (item!==undefined) result[key]=structuredClone(item) as Json;
  }
  return result;
}

function nodeDigest(node:MerkleNode):string {
  return createHash('sha256')
    .update(canonical(node as unknown as Json))
    .digest('hex');
}

class MerkleStore {
  readonly objects=new Map<string,MerkleNode>();

  put(node:MerkleNode):string {
    const copy=structuredClone(node);
    const id=nodeDigest(copy);
    this.objects.set(id,copy);
    return id;
  }

  get(id:string):MerkleNode {
    const node=this.objects.get(id);
    if (!node) throw new Error(`MISSING_MERKLE_NODE:${id}`);
    if (nodeDigest(node)!==id) throw new Error(`MERKLE_DIGEST_MISMATCH:${id}`);
    return node;
  }

  bytes():number {
    let total=0;
    for (const node of this.objects.values()) {
      total+=Buffer.byteLength(canonical(node as unknown as Json));
    }
    return total;
  }
}

function repository() {
  return {
    id:42,
    node_id:'R_42',
    full_name:'acme/widget',
    name:'widget',
    owner:{login:'acme'},
  };
}

function status() {
  return {
    id:7,
    node_id:'STATUS_7',
    state:'success',
    context:'overcenter/proof',
    target_url:null,
    created_at:'2026-09-23T03:59:59Z',
    updated_at:'2026-09-23T04:00:00Z',
  };
}

function providerGet(_token:string,path:string) {
  if (path==='/repos/acme/widget') return repository();
  if (path===`/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
    return {
      state:'success',
      sha:COMMIT,
      total_count:1,
      repository:repository(),
      statuses:[status()],
    };
  }
  if (path===`/repos/acme/widget/commits/${COMMIT}/statuses?page=1&per_page=30`) {
    return [status()];
  }
  throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
}

async function produce(index:number):Promise<{
  fact:ReceiptFact;
  receipt:Receipt;
  definition:ObligationDefinition;
}> {
  const root=mkdtempSync(join(tmpdir(),`merkle-v5-${index}-`));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'),{
    githubToken:'token',
    observationContext:{
      githubGet:providerGet as GithubJsonGet,
      clock:()=>FIXED_TIME,
    },
  });
  try {
    kernel.initialize();
    kernel.define({
      id:`status-proof-${index}`,
      packet:{effect_contract:GITHUB_COMMIT_STATUS_EFFECT},
      postcondition:{
        verifier:'github-commit-status/v2',
        provider:'github',
        repository_id:42,
        repository_full_name:'acme/widget',
        commit_sha:COMMIT,
        context:'overcenter/proof',
        expected_state:'success',
      },
    });
    const work=kernel.deriveReadyWork();
    assert.ok(work);
    const permit=kernel.claim(work.id,work.revision);
    const claimed=kernel.claimedWork(permit.id);
    await performGithubCommitStatusEffect(kernel,permit,{
      token:'token',
      get:async(token,path)=>providerGet(token,path),
      post:async()=>({status:201,body:'{}'}),
      clock:()=>FIXED_TIME,
    });
    const receipt=kernel.reconcile(permit);
    assert.equal(receipt.schema,'overcenter-git-receipt-v5');
    assert.equal(receipt.disposition,'DONE');
    assert.equal(receipt.verified,true);
    assert.equal(kernel.inspect()[0]?.status,'DONE');

    const {
      disposition:_disposition,
      verified:_verified,
      settlement_commit:_settlement,
      ...rawFact
    }=receipt;
    const fact=validateReceiptFact(rawFact);
    return {
      fact,
      receipt,
      definition:obligationDefinition({
        id:claimed.id,
        dependencies:claimed.dependencies,
        packet:claimed.packet,
        postcondition:claimed.postcondition,
      }),
    };
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
}

function encode(store:MerkleStore,fact:ReceiptFact,definition:ObligationDefinition):Encoded {
  const definitionId=store.put({
    schema:'overcenter-merkle-receipt-v5-node/v1',
    kind:'definition',
    parents:{},
    payload:{definition:definition as unknown as Json},
  });
  const observationId=fact.observed===null
    ? null
    : store.put({
        schema:'overcenter-merkle-receipt-v5-node/v1',
        kind:'observation',
        parents:{},
        payload:{observed:fact.observed as unknown as Json},
      });
  const executionId=store.put({
    schema:'overcenter-merkle-receipt-v5-node/v1',
    kind:'execution',
    parents:{definition:definitionId},
    payload:{
      run_id:fact.run_id,
      obligation_id:fact.obligation_id,
      claimed_revision:fact.claimed_revision,
      claim_commit:fact.claim_commit,
      execution_generation:fact.execution_generation,
      execution_authority_commit:fact.execution_authority_commit,
    },
  });
  const parents:Record<string,string>={
    definition:definitionId,
    execution:executionId,
    ...(observationId?{observation:observationId}:{}),
  };
  const payload:Record<string,Json>={
    receipt_schema:fact.schema,
    kind:fact.kind,
    settled_at:fact.settled_at,
  };
  if (fact.diagnostic!==undefined) payload.diagnostic=fact.diagnostic as unknown as Json;
  const root=store.put({
    schema:'overcenter-merkle-receipt-v5-node/v1',
    kind:'settlement',
    parents,
    payload,
  });
  return {root,definition:definitionId,observation:observationId,execution:executionId};
}

function reconstruct(store:MerkleStore,root:string):{
  fact:ReceiptFact;
  obligation:Obligation;
} {
  const settlement=store.get(root);
  if (settlement.kind!=='settlement') throw new Error('EXPECTED_SETTLEMENT');
  const executionId=settlement.parents.execution;
  const definitionId=settlement.parents.definition;
  if (!executionId || !definitionId) throw new Error('SETTLEMENT_PARENT_MISSING');

  const execution=store.get(executionId);
  const definitionNode=store.get(definitionId);
  if (execution.kind!=='execution' || definitionNode.kind!=='definition') {
    throw new Error('MERKLE_KIND_MISMATCH');
  }
  if (execution.parents.definition!==definitionId) {
    throw new Error('EXECUTION_DEFINITION_MISMATCH');
  }

  const definition=definitionNode.payload.definition as unknown as ObligationDefinition;
  const observationId=settlement.parents.observation;
  let observed:ReceiptFact['observed']=null;
  if (observationId) {
    const observation=store.get(observationId);
    if (observation.kind!=='observation') throw new Error('EXPECTED_OBSERVATION');
    observed=observation.payload.observed as ReceiptFact['observed'];
  }

  const raw:Record<string,unknown>={
    schema:settlement.payload.receipt_schema,
    run_id:execution.payload.run_id,
    obligation_id:execution.payload.obligation_id,
    claimed_revision:execution.payload.claimed_revision,
    claim_commit:execution.payload.claim_commit,
    execution_generation:execution.payload.execution_generation,
    execution_authority_commit:execution.payload.execution_authority_commit,
    kind:settlement.payload.kind,
    observed,
    settled_at:settlement.payload.settled_at,
  };
  if (Object.hasOwn(settlement.payload,'diagnostic')) {
    raw.diagnostic=settlement.payload.diagnostic as Data;
  }
  const fact=validateReceiptFact(raw);
  const obligation=materializeObligation(fact.obligation_id,definition);
  return {fact,obligation};
}

function reconstructAuthorized(
  store:MerkleStore,
  root:string,
  settlementCommit:string,
  authorityRoots:Map<string,string>,
):{fact:ReceiptFact;obligation:Obligation} {
  const authorized=authorityRoots.get(settlementCommit);
  if (authorized!==root) throw new Error('SETTLEMENT_ROOT_UNAUTHORIZED');
  return reconstruct(store,root);
}

function flatCorpusBytes(
  items:Array<{fact:ReceiptFact;definition:ObligationDefinition}>,
):number {
  assert.ok(items.length>0);
  const definitionBytes=Buffer.byteLength(
    canonical(items[0]!.definition as unknown as Json),
  );
  return definitionBytes+items.reduce(
    (sum,item)=>sum+Buffer.byteLength(canonical(item.fact as unknown as Json)),
    0,
  );
}

function rootsBytes(roots:string[]):number {
  return Buffer.byteLength(canonical(roots as unknown as Json));
}

test('actual receipt-v5 corpus round-trips with semantic parity and amortized bytes',async()=>{
  const count=128;
  const corpus:Array<{
    fact:ReceiptFact;
    receipt:Receipt;
    definition:ObligationDefinition;
  }>=[];
  for (let i=0;i<count;i+=1) corpus.push(await produce(i));

  const store=new MerkleStore();
  const encoded:Encoded[]=[];
  const encodeTimes:number[]=[];
  for (const item of corpus) {
    const start=performance.now();
    encoded.push(encode(store,item.fact,item.definition));
    encodeTimes.push((performance.now()-start)*1000);
  }

  const authorityRoots=new Map<string,string>();
  for (let i=0;i<corpus.length;i+=1) {
    const settlementCommit=corpus[i]!.receipt.settlement_commit;
    assert.ok(settlementCommit);
    authorityRoots.set(settlementCommit,encoded[i]!.root);
  }

  const validateTimes:number[]=[];
  for (let i=0;i<corpus.length;i+=1) {
    const original=corpus[i]!;
    const settlementCommit=original.receipt.settlement_commit;
    assert.ok(settlementCommit);
    const start=performance.now();
    const rebuilt=reconstructAuthorized(
      store,
      encoded[i]!.root,
      settlementCommit,
      authorityRoots,
    );
    const projected=projectReceipt(rebuilt.fact,rebuilt.obligation);
    validateTimes.push((performance.now()-start)*1000);
    assert.equal(
      canonical(rebuilt.fact as unknown as Json),
      canonical(original.fact as unknown as Json),
    );
    assert.equal(projected.disposition,original.receipt.disposition);
    assert.equal(projected.verified,original.receipt.verified);
  }

  const sampleSizes=[1,8,32,64,128];
  const ratios:Record<string,number>={};
  let crossover:number|null=null;
  for (const size of sampleSizes) {
    const roots=encoded.slice(0,size).map(item=>item.root);
    const reachable=new Set<string>();
    const visit=(id:string):void=>{
      if (reachable.has(id)) return;
      const node=store.get(id);
      reachable.add(id);
      for (const parent of Object.values(node.parents)) visit(parent);
    };
    for (const root of roots) visit(root);
    let merkleBytes=rootsBytes(roots);
    for (const id of reachable) {
      merkleBytes+=Buffer.byteLength(canonical(store.get(id) as unknown as Json));
    }
    const flatBytes=flatCorpusBytes(corpus.slice(0,size));
    const ratio=merkleBytes/flatBytes;
    ratios[String(size)]=Number(ratio.toFixed(3));
    if (crossover===null && ratio<=1) crossover=size;
  }

  assert.ok(ratios['128']!<=1,'128-receipt Merkle corpus did not amortize flat bytes');

  const first=encoded[0]!;
  const second=encoded[1]!;
  const settlement=store.get(first.root);
  const substituted=store.put({
    ...structuredClone(settlement),
    parents:{
      ...settlement.parents,
      execution:second.execution,
    },
  });
  const firstSettlementCommit=corpus[0]!.receipt.settlement_commit;
  assert.ok(firstSettlementCommit);
  assert.throws(
    ()=>reconstructAuthorized(
      store,
      substituted,
      firstSettlementCommit,
      authorityRoots,
    ),
    /SETTLEMENT_ROOT_UNAUTHORIZED/,
  );

  const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!;
  const uniqueDefinitions=new Set(encoded.map(item=>item.definition)).size;
  const uniqueObservations=new Set(encoded.map(item=>item.observation)).size;
  const result={
    schema:'overcenter-merkle-receipt-v5-dedup-result/v1',
    receipts:count,
    unique_objects:store.objects.size,
    unique_definitions:uniqueDefinitions,
    unique_observations:uniqueObservations,
    ratios,
    crossover,
    encode_p50_us:Number(median(encodeTimes).toFixed(3)),
    reconstruct_project_p50_us:Number(median(validateTimes).toFixed(3)),
    semantic_mismatches:0,
    false_done:0,
  };
  assert.equal(uniqueDefinitions,1);
  assert.equal(uniqueObservations,1);
  console.log('MERKLE_RECEIPT_V5_DEDUP_RESULT '+JSON.stringify(result));
});
