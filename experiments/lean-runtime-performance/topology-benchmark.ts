import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';

import { validateAdmission } from '../../src/admission.ts';
import { claimabilityError } from '../../src/eligibility.ts';
import { obligationKey } from '../../src/lifecycle.ts';

const oneShot='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmission';
const server='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmissionServer';
const sizes=[10,25,50,100,200,400] as const;

function id(i:number){return `n-${String(i).padStart(4,'0')}`;}

function buildChain(size:number) {
  const obligations:Record<string,any>={};
  const lifecycles=new Map<string,any>();
  for (let i=0;i<size;i++) {
    const current=id(i);
    const dependencies=i===0?[]:[{kind:'control',upstream:id(i-1)}];
    obligations[current]={
      id:current,
      dependencies,
      packet:{kind:'chain',i},
      postcondition:{verifier:'file-content-equals/v1',path:`/x/${current}`,content:current},
    };
    lifecycles.set(current,{status:i===size-1?'UNREALIZED':'DONE'});
  }
  const targetId=id(size-1);
  const state={obligations,definition_commits:Object.fromEntries(Object.keys(obligations).map(k=>[k,'c']))};
  const request={
    command:'claim-admission',
    current_revision:'r1',
    expected_revision:'r1',
    target_id:targetId,
    obligations:Object.values(obligations).map((o:any)=>({
      id:o.id,
      dependencies:o.dependencies.map((d:any)=>({
        upstream:d.upstream,
        kind:'control',
        semantic_identity:null,
      })),
      effect:null,
    })),
    lifecycles:Object.keys(obligations).map((obligation_id,i)=>({
      obligation_id,
      status:i===size-1?'UNREALIZED':'DONE',
    })),
  };
  return {state,lifecycles,targetId,request};
}

function tsAdmitted(f:any) {
  try { validateAdmission(f.state); } catch { return false; }
  const target=f.state.obligations[f.targetId];
  if (claimabilityError(f.state,target,f.lifecycles)) return false;
  return obligationKey(f.state,target,f.lifecycles,new Map())!==null;
}

function timed<T>(fn:()=>T){const s=performance.now();const value=fn();return {ms:performance.now()-s,value};}

class Server {
  child=spawn(server,[],{stdio:['pipe','pipe','pipe']});
  buf='';
  pending:Array<(line:string)=>void>=[];
  constructor(){
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      this.buf+=chunk;
      for(;;){
        const i=this.buf.indexOf('\n'); if(i<0) break;
        const line=this.buf.slice(0,i); this.buf=this.buf.slice(i+1);
        this.pending.shift()?.(line);
      }
    });
  }
  async request(req:unknown){
    const s=performance.now();
    const line=await new Promise<string>(resolve=>{
      this.pending.push(resolve);
      this.child.stdin.write(JSON.stringify(req)+'\n');
    });
    return {ms:performance.now()-s,value:JSON.parse(line)};
  }
  async close(){this.child.stdin.end(); await once(this.child,'exit');}
}

const p=new Server();
try {
  for(const size of sizes){
    const f=buildChain(size);
    const ts=timed(()=>tsAdmitted(f));
    const persistent=await p.request(f.request);
    const shot=timed(()=>JSON.parse(execFileSync(oneShot,[],{
      input:JSON.stringify(f.request),encoding:'utf8',timeout:60_000,maxBuffer:64*1024*1024,
    })));
    if(!ts.value||!persistent.value.admitted||!shot.value.admitted) throw new Error(`parity failure at ${size}`);
    console.log('TOPOLOGY_ROW '+JSON.stringify({
      topology:'chain',
      obligations:size,
      typescript_ms:ts.ms,
      lean_persistent_ms:persistent.ms,
      lean_one_shot_ms:shot.ms,
    }));
  }
} finally {
  await p.close();
}
