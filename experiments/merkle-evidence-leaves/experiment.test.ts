import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { canonicalDigest } from '../../src/digest.ts';
import { SqliteFactStore } from '../../src/storage/sqlite.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';
import type { GithubJsonGet } from '../../src/providers/github/rest.ts';
import type { JsonValue } from '../../src/model.ts';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {[key:string]:Json};

interface ExternalizedReceipt {
  schema:'overcenter-receipt-v5-evidence-ref/v1';
  receipt:Record<string,Json>;
  observed_ref:string|null;
}

const COMMIT='a'.repeat(40);
const FIXED_TIME='2026-09-23T04:00:00.000Z';
const SQLITE_COMMIT_SCHEMA='overcenter-sqlite-fact-commit-v1';

function canonical(value:Json):string {
  if (value===null) return 'null';
  if (typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k]!)).join(',')+'}';
}

function repository() {
  return {id:42,node_id:'R_42',full_name:'acme/widget',name:'widget',owner:{login:'acme'}};
}
function status() {
  return {
    id:7,node_id:'STATUS_7',state:'success',context:'overcenter/proof',target_url:null,
    created_at:'2026-09-23T03:59:59Z',updated_at:'2026-09-23T04:00:00Z',
  };
}
function providerGet(_token:string,path:string) {
  if (path==='/repos/acme/widget') return repository();
  if (path===`/repos/acme/widget/commits/${COMMIT}/status?page=1&per_page=100`) {
    return {state:'success',sha:COMMIT,total_count:1,repository:repository(),statuses:[status()]};
  }
  if (path===`/repos/acme/widget/commits/${COMMIT}/statuses?page=1&per_page=30`) return [status()];
  throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
}

async function produce(index:number):Promise<{
  fact:ReceiptFact;
  receipt:Receipt;
  definition:ObligationDefinition;
}> {
  const root=mkdtempSync(join(tmpdir(),`merkle-leaf-${index}-`));
  const database=join(root,'overcenter.sqlite');
  const kernel=new OvercenterKernel(database,{
    githubToken:'token',
    observationContext:{githubGet:providerGet as GithubJsonGet,clock:()=>FIXED_TIME},
  });
  let head:string;
  let receipt:Receipt;
  let definition:ObligationDefinition;
  try {
    kernel.initialize();
    kernel.define({
      id:`status-proof-${index}`,
      packet:{effect_contract:GITHUB_COMMIT_STATUS_EFFECT},
      postcondition:{
        verifier:'github-commit-status/v2',provider:'github',repository_id:42,
        repository_full_name:'acme/widget',commit_sha:COMMIT,
        context:'overcenter/proof',expected_state:'success',
      },
    });
    const work=kernel.deriveReadyWork();
    assert.ok(work);
    const permit=kernel.claim(work.id,work.revision);
    const claimed=kernel.claimedWork(permit.id);
    definition=obligationDefinition({
      id:claimed.id,
      dependencies:claimed.dependencies,
      packet:claimed.packet,
      postcondition:claimed.postcondition,
    });
    await performGithubCommitStatusEffect(kernel,permit,{
      token:'token',
      get:async(token,path)=>providerGet(token,path),
      post:async()=>({status:201,body:'{}'}),
      clock:()=>FIXED_TIME,
    });
    receipt=kernel.reconcile(permit);
    assert.equal(receipt.disposition,'DONE');
    head=kernel.head()!;
  } finally {
    kernel.close();
  }

  const store=new SqliteFactStore(database);
  try {
    const history=store.history(head!);
    const record=[...history].reverse().find(item=>item.receipt!=null);
    assert.ok(record?.receipt);
    const fact=validateReceiptFact(record.receipt);
    const {
      disposition:_disposition,
      verified:_verified,
      settlement_commit:_commit,
      ...returnedFact
    }=receipt!;
    assert.equal(
      canonical(fact as unknown as Json),
      canonical(validateReceiptFact(returnedFact) as unknown as Json),
    );
    return {fact,receipt:receipt!,definition:definition!};
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
}

class EvidenceStore {
  readonly objects=new Map<string,Json>();

  put(value:Json):string {
    const bytes=canonical(value);
    const digest=createHash('sha256').update(bytes).digest('hex');
    this.objects.set(digest,structuredClone(value));
    return digest;
  }

  get(digest:string):Json {
    const value=this.objects.get(digest);
    if (value===undefined) throw new Error('EVIDENCE_MISSING');
    const actual=createHash('sha256').update(canonical(value)).digest('hex');
    if (actual!==digest) throw new Error('EVIDENCE_DIGEST_MISMATCH');
    return structuredClone(value);
  }

  corrupt(digest:string,value:Json):void {
    this.objects.set(digest,structuredClone(value));
  }

  bytes():number {
    let total=0;
    for (const value of this.objects.values()) total+=Buffer.byteLength(canonical(value));
    return total;
  }
}

function externalize(store:EvidenceStore,fact:ReceiptFact):ExternalizedReceipt {
  const {
    observed,
    ...rest
  }=fact;
  return {
    schema:'overcenter-receipt-v5-evidence-ref/v1',
    receipt:rest as unknown as Record<string,Json>,
    observed_ref:observed===null ? null : store.put(observed as unknown as Json),
  };
}

function hydrate(store:EvidenceStore,value:ExternalizedReceipt):ReceiptFact {
  const observed=value.observed_ref===null
    ? null
    : store.get(value.observed_ref);
  return validateReceiptFact({
    ...value.receipt,
    observed,
  });
}

function flatBytes(items:Array<{fact:ReceiptFact;definition:ObligationDefinition}>):number {
  return Buffer.byteLength(canonical(items[0]!.definition as unknown as Json))
    +items.reduce((sum,item)=>sum+Buffer.byteLength(canonical(item.fact as unknown as Json)),0);
}

function treatmentBytes(
  items:Array<{definition:ObligationDefinition}>,
  encoded:ExternalizedReceipt[],
  evidence:EvidenceStore,
):number {
  return Buffer.byteLength(canonical(items[0]!.definition as unknown as Json))
    +encoded.reduce((sum,item)=>sum+Buffer.byteLength(canonical(item as unknown as Json)),0)
    +evidence.bytes();
}

test('existing authority spine plus Merkle evidence leaves preserves receipt truth',async()=>{
  const count=128;
  const corpus=[];
  for (let i=0;i<count;i+=1) corpus.push(await produce(i));

  const evidence=new EvidenceStore();
  const encoded=corpus.map(item=>externalize(evidence,item.fact));

  for (let i=0;i<count;i+=1) {
    const hydrated=hydrate(evidence,encoded[i]!);
    const original=corpus[i]!;
    assert.equal(
      canonical(hydrated as unknown as Json),
      canonical(original.fact as unknown as Json),
    );
    const obligation=materializeObligation(hydrated.obligation_id,original.definition);
    const projected=projectReceipt(hydrated,obligation);
    assert.equal(projected.disposition,original.receipt.disposition);
    assert.equal(projected.verified,original.receipt.verified);
  }

  const sizes=[1,8,32,64,128];
  const ratios:Record<string,number>={};
  for (const size of sizes) {
    const localEvidence=new EvidenceStore();
    const localEncoded=corpus.slice(0,size).map(item=>externalize(localEvidence,item.fact));
    ratios[String(size)]=Number((
      treatmentBytes(corpus.slice(0,size),localEncoded,localEvidence)
      /flatBytes(corpus.slice(0,size))
    ).toFixed(3));
  }
  assert.ok(ratios['128']!<=0.56,'evidence-leaf representation missed preregistered storage threshold');
  assert.equal(evidence.objects.size,1);

  const first=encoded[0]!;
  const changed=structuredClone(first);
  changed.receipt.run_id=encoded[1]!.receipt.run_id!;
  const parent='f'.repeat(64);
  const originalCommit=canonicalDigest({
    schema:SQLITE_COMMIT_SCHEMA,sequence:1,parent,message:'settle',
    files:{'receipt-ref.json':first},
  });
  const changedCommit=canonicalDigest({
    schema:SQLITE_COMMIT_SCHEMA,sequence:1,parent,message:'settle',
    files:{'receipt-ref.json':changed},
  });
  assert.notEqual(changedCommit,originalCommit);

  const ref=first.observed_ref!;
  const correct=evidence.get(ref) as Record<string,Json>;
  evidence.corrupt(ref,{...correct,observed_at:'2099-01-01T00:00:00.000Z'});
  assert.throws(()=>hydrate(evidence,first),/EVIDENCE_DIGEST_MISMATCH/);

  const missing=new EvidenceStore();
  assert.throws(()=>hydrate(missing,first),/EVIDENCE_MISSING/);

  console.log('MERKLE_EVIDENCE_LEAVES_RESULT '+JSON.stringify({
    schema:'overcenter-merkle-evidence-leaves-result/v1',
    receipts:count,
    evidence_objects:1,
    ratios,
    semantic_mismatches:0,
    false_done:0,
  }));
});
