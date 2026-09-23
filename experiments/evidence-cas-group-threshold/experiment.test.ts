import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import { validateReceiptFact, type ReceiptFact } from '../../src/authority/facts.ts';
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

interface Base {
  fact:ReceiptFact;
  obligation:Obligation;
}

interface Trace {
  schema:'overcenter-execution-trace/v1';
  payload:string;
}

interface RefReceipt {
  fact:Record<string,Json>;
  trace_ref:string;
}

const COMMIT='a'.repeat(40);
const FIXED_TIME='2026-09-23T04:00:00.000Z';
const SIZES=[32,64,128,256,512,1024,4096,16384] as const;
const MULTIPLICITIES=[1,2,3,4,8,16] as const;

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

async function produce(index:number):Promise<Base> {
  const root=mkdtempSync(join(tmpdir(),`evidence-group-${index}-`));
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
    const claimed=kernel.claimedWork(permit.id);
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
      obligation:{
        id:claimed.id,
        dependencies:claimed.dependencies,
        packet:claimed.packet,
        postcondition:claimed.postcondition,
      },
    };
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
}

function trace(target:number):Trace {
  const prefix='trace:';
  return {
    schema:'overcenter-execution-trace/v1',
    payload:prefix+'x'.repeat(Math.max(0,target-prefix.length)),
  };
}

function inline(base:ReceiptFact,t:Trace):ReceiptFact {
  return validateReceiptFact({...base,diagnostic:{execution_trace:t}});
}

function ref(fact:ReceiptFact,digest:string):RefReceipt {
  const {diagnostic:_diagnostic,...rest}=fact;
  return {fact:rest as unknown as Record<string,Json>,trace_ref:digest};
}

function digestFor(t:Trace):string {
  return createHash('sha256').update(canonical(t as unknown as Json)).digest('hex');
}

test('exact digest-group CAS break-even surface',async()=>{
  const bases:Base[]=[];
  for (let i=0;i<16;i+=1) bases.push(await produce(i));

  const cells:Record<string,Record<string,{
    inline_bytes:number;
    cas_bytes:number;
    ratio:number;
    winner:'inline'|'cas';
  }>>={};
  const minWinningMultiplicity:Record<string,number|null>={};
  const minWinningPayload:Record<string,number|null>={};
  for (const m of MULTIPLICITIES) minWinningPayload[String(m)]=null;

  for (const size of SIZES) {
    const t=trace(size);
    const d=digestFor(t);
    const objectBytes=bytes(t as unknown as Json);
    const sizeKey=String(size);
    cells[sizeKey]={};
    minWinningMultiplicity[sizeKey]=null;

    for (const multiplicity of MULTIPLICITIES) {
      const facts=bases.slice(0,multiplicity).map(base=>inline(base.fact,t));
      const refs=facts.map(fact=>ref(fact,d));
      const inlineBytes=facts.reduce((sum,fact)=>sum+bytes(fact as unknown as Json),0);
      const casBytes=refs.reduce((sum,item)=>sum+bytes(item as unknown as Json),0)+objectBytes;
      const winner=casBytes<inlineBytes ? 'cas' : 'inline';

      for (let i=0;i<multiplicity;i+=1) {
        const hydrated=validateReceiptFact({
          ...refs[i]!.fact,
          diagnostic:{execution_trace:t},
        });
        assert.equal(
          canonical(hydrated as unknown as Json),
          canonical(facts[i] as unknown as Json),
        );
        const before=projectReceipt(facts[i]!,bases[i]!.obligation);
        const after=projectReceipt(hydrated,bases[i]!.obligation);
        assert.equal(after.disposition,before.disposition);
        assert.equal(after.verified,before.verified);
      }

      cells[sizeKey]![String(multiplicity)]={
        inline_bytes:inlineBytes,
        cas_bytes:casBytes,
        ratio:Number((casBytes/inlineBytes).toFixed(4)),
        winner,
      };

      if (multiplicity===1) assert.equal(winner,'inline');
      if (winner==='cas' && minWinningMultiplicity[sizeKey]===null) {
        minWinningMultiplicity[sizeKey]=multiplicity;
      }
      const mKey=String(multiplicity);
      if (winner==='cas' && minWinningPayload[mKey]===null) {
        minWinningPayload[mKey]=size;
      }
      assert.equal(winner,casBytes<inlineBytes?'cas':'inline');
    }
  }

  console.log('EVIDENCE_CAS_GROUP_THRESHOLD_RESULT '+JSON.stringify({
    schema:'overcenter-evidence-cas-group-threshold-result/v1',
    cells,
    min_winning_multiplicity:minWinningMultiplicity,
    min_winning_payload_bytes:minWinningPayload,
    semantic_mismatches:0,
    false_done:0,
  }));
});
