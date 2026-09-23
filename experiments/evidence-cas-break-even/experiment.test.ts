import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import {
  validateReceiptFact,
  type Receipt,
  type ReceiptFact,
} from '../../src/authority/facts.ts';
import { projectReceipt } from '../../src/authority/replay.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';
import type { GithubJsonGet } from '../../src/providers/github/rest.ts';
import type { Obligation } from '../../src/model.ts';

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {[key:string]:Json};

interface BaseReceipt {
  fact:ReceiptFact;
  receipt:Receipt;
  obligation:Obligation;
}

interface TraceObject {
  schema:'overcenter-execution-trace/v1';
  payload:string;
}

interface RefReceipt {
  fact:Record<string,Json>;
  trace_ref:string;
}

const COMMIT='a'.repeat(40);
const FIXED_TIME='2026-09-23T04:00:00.000Z';
const COUNT=128;
const SIZES=[1024,16*1024,256*1024,1024*1024] as const;
const REUSE=[0,0.25,0.5,0.75,1] as const;

function canonical(value:Json):string {
  if (value===null) return 'null';
  if (typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>
    JSON.stringify(key)+':'+canonical(value[key]!)
  ).join(',')+'}';
}

const bytes=(value:Json)=>Buffer.byteLength(canonical(value));
const digest=(value:Json)=>createHash('sha256').update(canonical(value)).digest('hex');

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

async function produceBase(index:number):Promise<BaseReceipt> {
  const root=mkdtempSync(join(tmpdir(),`evidence-break-even-${index}-`));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'),{
    githubToken:'token',
    observationContext:{githubGet:providerGet as GithubJsonGet,clock:()=>FIXED_TIME},
  });
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
    const obligation=kernel.claimedWork(permit.id);
    await performGithubCommitStatusEffect(kernel,permit,{
      token:'token',
      get:async(token,path)=>providerGet(token,path),
      post:async()=>({status:201,body:'{}'}),
      clock:()=>FIXED_TIME,
    });
    const receipt=kernel.reconcile(permit);
    const {
      disposition:_disposition,
      verified:_verified,
      settlement_commit:_settlement,
      ...raw
    }=receipt;
    return {
      fact:validateReceiptFact(raw),
      receipt,
      obligation:{
        id:obligation.id,
        dependencies:obligation.dependencies,
        packet:obligation.packet,
        postcondition:obligation.postcondition,
      },
    };
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
}

function traceObject(targetBytes:number,variant:number):TraceObject {
  const prefix=`trace:${variant}:`;
  return {
    schema:'overcenter-execution-trace/v1',
    payload:prefix+'x'.repeat(Math.max(0,targetBytes-prefix.length)),
  };
}

function uniqueCount(reuse:number):number {
  if (reuse===1) return 1;
  return Math.max(1,Math.round(COUNT*(1-reuse)));
}

function inlineFact(base:ReceiptFact,trace:TraceObject):ReceiptFact {
  return validateReceiptFact({
    ...base,
    diagnostic:{execution_trace:trace},
  });
}

function externalize(fact:ReceiptFact):{ref:RefReceipt;trace:TraceObject} {
  const diagnostic=fact.diagnostic as unknown as {execution_trace:TraceObject};
  const trace=diagnostic.execution_trace;
  const {
    diagnostic:_diagnostic,
    ...rest
  }=fact;
  return {
    ref:{
      fact:rest as unknown as Record<string,Json>,
      trace_ref:digest(trace as unknown as Json),
    },
    trace,
  };
}

function hydrate(ref:RefReceipt,objects:Map<string,TraceObject>):ReceiptFact {
  const trace=objects.get(ref.trace_ref);
  if (!trace) throw new Error('TRACE_MISSING');
  if (digest(trace as unknown as Json)!==ref.trace_ref) throw new Error('TRACE_DIGEST_MISMATCH');
  return validateReceiptFact({
    ...ref.fact,
    diagnostic:{execution_trace:trace},
  });
}

function percentile(values:number[],p:number):number {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]!;
}

function buildScenario(base:BaseReceipt[],size:number,reuse:number) {
  const uniques=uniqueCount(reuse);
  const inline:ReceiptFact[]=[];
  const refs:RefReceipt[]=[];
  const objects=new Map<string,TraceObject>();
  const groups=new Map<string,{trace:TraceObject;refs:RefReceipt[];inline:ReceiptFact[]}>();

  for (let i=0;i<COUNT;i+=1) {
    const trace=traceObject(size,i%uniques);
    const fact=inlineFact(base[i]!.fact,trace);
    const {ref}=externalize(fact);
    inline.push(fact);
    refs.push(ref);
    objects.set(ref.trace_ref,trace);
    const group=groups.get(ref.trace_ref)??{trace,refs:[],inline:[]};
    group.refs.push(ref);
    group.inline.push(fact);
    groups.set(ref.trace_ref,group);
  }

  const flatBytes=inline.reduce((sum,fact)=>sum+bytes(fact as unknown as Json),0);
  const universalBytes=
    refs.reduce((sum,ref)=>sum+bytes(ref as unknown as Json),0)
    +[...objects.values()].reduce((sum,obj)=>sum+bytes(obj as unknown as Json),0);

  let selectiveBytes=0;
  let externalizedGroups=0;
  for (const group of groups.values()) {
    const inlineGroup=group.inline.reduce(
      (sum,fact)=>sum+bytes(fact as unknown as Json),0,
    );
    const externalGroup=
      group.refs.reduce((sum,ref)=>sum+bytes(ref as unknown as Json),0)
      +bytes(group.trace as unknown as Json);
    if (externalGroup<inlineGroup) {
      selectiveBytes+=externalGroup;
      externalizedGroups+=1;
    } else {
      selectiveBytes+=inlineGroup;
    }
  }

  for (let i=0;i<COUNT;i+=1) {
    const hydrated=hydrate(refs[i]!,objects);
    assert.equal(
      canonical(hydrated as unknown as Json),
      canonical(inline[i] as unknown as Json),
    );
    const original=projectReceipt(inline[i]!,base[i]!.obligation);
    const rebuilt=projectReceipt(hydrated,base[i]!.obligation);
    assert.equal(rebuilt.disposition,original.disposition);
    assert.equal(rebuilt.verified,original.verified);
  }

  return {
    inline,
    refs,
    objects,
    flatBytes,
    universalBytes,
    selectiveBytes,
    externalizedGroups,
  };
}

class FileCas {
  readonly dir:string;
  constructor() {
    this.dir=mkdtempSync(join(tmpdir(),'overcenter-evidence-cas-'));
  }
  put(value:TraceObject):string {
    const id=digest(value as unknown as Json);
    const path=join(this.dir,id);
    if (!readdirSync(this.dir).includes(id)) {
      writeFileSync(path,canonical(value as unknown as Json));
    }
    return id;
  }
  get(id:string):TraceObject {
    const raw=readFileSync(join(this.dir,id),'utf8');
    const actual=createHash('sha256').update(raw).digest('hex');
    if (actual!==id) throw new Error('FILE_CAS_DIGEST_MISMATCH');
    return JSON.parse(raw) as TraceObject;
  }
  ids():string[] {
    return readdirSync(this.dir);
  }
  bytes():number {
    return this.ids().reduce((sum,id)=>sum+statSync(join(this.dir,id)).size,0);
  }
  remove(id:string):void {
    unlinkSync(join(this.dir,id));
  }
  close():void {
    rmSync(this.dir,{recursive:true,force:true});
  }
}

test('evidence CAS break-even, lookup, GC, and recovery bandwidth',async()=>{
  const base:BaseReceipt[]=[];
  for (let i=0;i<COUNT;i+=1) base.push(await produceBase(i));

  const matrix:Record<string,Record<string,{
    universal_ratio:number;
    selective_ratio:number;
    unique_objects:number;
    selective_externalized_groups:number;
  }>>={};
  const crossover:Record<string,number|null>={};

  for (const size of SIZES) {
    const sizeKey=String(size);
    matrix[sizeKey]={};
    crossover[sizeKey]=null;
    for (const reuse of REUSE) {
      const scenario=buildScenario(base,size,reuse);
      const universalRatio=scenario.universalBytes/scenario.flatBytes;
      const selectiveRatio=scenario.selectiveBytes/scenario.flatBytes;
      const reuseKey=String(Math.round(reuse*100));
      matrix[sizeKey]![reuseKey]={
        universal_ratio:Number(universalRatio.toFixed(4)),
        selective_ratio:Number(selectiveRatio.toFixed(4)),
        unique_objects:scenario.objects.size,
        selective_externalized_groups:scenario.externalizedGroups,
      };

      if (reuse===0) {
        assert.ok(universalRatio>1,'zero-reuse universal CAS unexpectedly beat flat');
      }
      if (reuse===1) {
        assert.ok(universalRatio<1,'full-reuse universal CAS failed to beat flat');
      }
      assert.ok(
        selectiveRatio<=1+1e-12,
        'exact-cost selective policy exceeded flat storage',
      );
      if (crossover[sizeKey]===null && universalRatio<=1) {
        crossover[sizeKey]=Math.round(reuse*100);
      }
    }
  }

  const representative=buildScenario(base,256*1024,0.5);
  const cas=new FileCas();
  try {
    for (const object of representative.objects.values()) cas.put(object);
    const live=new Set(representative.refs.map(ref=>ref.trace_ref));

    const lookupUs:number[]=[];
    for (const ref of representative.refs) {
      const start=performance.now();
      const trace=cas.get(ref.trace_ref);
      assert.equal(digest(trace as unknown as Json),ref.trace_ref);
      lookupUs.push((performance.now()-start)*1000);
    }

    const coldRecoveryBytes=
      representative.refs.reduce((sum,ref)=>sum+bytes(ref as unknown as Json),0)
      +cas.bytes();
    const warmRecoveryBytes=
      representative.refs.reduce((sum,ref)=>sum+bytes(ref as unknown as Json),0);

    const orphanCount=16;
    const orphanIds:string[]=[];
    for (let i=0;i<orphanCount;i+=1) {
      orphanIds.push(cas.put(traceObject(256*1024,10000+i)));
    }
    const beforeGc=cas.bytes();
    const gcStart=performance.now();
    let deleted=0;
    for (const id of cas.ids()) {
      if (!live.has(id)) {
        cas.remove(id);
        deleted+=1;
      }
    }
    const gcUs=(performance.now()-gcStart)*1000;
    const afterGc=cas.bytes();

    assert.equal(deleted,orphanCount);
    assert.equal(cas.ids().length,live.size);
    for (const id of live) assert.doesNotThrow(()=>cas.get(id));
    for (const id of orphanIds) assert.ok(!cas.ids().includes(id));

    console.log('EVIDENCE_CAS_BREAK_EVEN_RESULT '+JSON.stringify({
      schema:'overcenter-evidence-cas-break-even-result/v1',
      receipts:COUNT,
      matrix,
      crossover_reuse_percent:crossover,
      representative:{
        payload_bytes:256*1024,
        reuse_percent:50,
        unique_objects:live.size,
        lookup_p50_us:Number(percentile(lookupUs,0.50).toFixed(3)),
        lookup_p95_us:Number(percentile(lookupUs,0.95).toFixed(3)),
        cold_recovery_bytes:coldRecoveryBytes,
        warm_recovery_bytes:warmRecoveryBytes,
        flat_recovery_bytes:representative.flatBytes,
        gc_orphans_deleted:deleted,
        gc_reclaimed_bytes:beforeGc-afterGc,
        gc_sweep_us:Number(gcUs.toFixed(3)),
      },
      semantic_mismatches:0,
      false_done:0,
    }));
  } finally {
    cas.close();
  }
});
