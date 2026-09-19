import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';

import { validateAdmission } from '../../src/admission.ts';
import { claimabilityError } from '../../src/eligibility.ts';
import { obligationKey } from '../../src/lifecycle.ts';

const oneShot='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmission';
const server='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmissionServer';

type Desired='success'|'failure';

function id(i:number){return `n-${String(i).padStart(5,'0')}`;}

function filePostcondition(current:string){
  return {verifier:'file-content-equals/v1',path:`/x/${current}`,content:current};
}

function statusPostcondition(desired:Desired){
  return {
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id:1,
    commit_sha:'deadbeef',
    context:'overcenter-runtime',
    expected_state:desired,
  };
}

function buildFixture(
  size:number,
  topology:string,
  dependenciesFor:(i:number)=>number[],
  desiredFor?:(i:number)=>Desired,
){
  const obligations:Record<string,any>={};
  const lifecycles=new Map<string,any>();

  for(let i=0;i<size;i++){
    const current=id(i);
    const dependencyIds=[...new Set(dependenciesFor(i))]
      .filter(upstream=>upstream>=0&&upstream<i);
    const dependencies=dependencyIds.map(upstream=>({
      kind:'control' as const,
      upstream:id(upstream),
    }));
    obligations[current]={
      id:current,
      dependencies,
      packet:{kind:'topology-benchmark',topology,i},
      postcondition:desiredFor
        ?statusPostcondition(desiredFor(i))
        :filePostcondition(current),
    };
    lifecycles.set(current,{status:i===size-1?'UNREALIZED':'DONE'});
  }

  const targetId=id(size-1);
  const state={
    obligations,
    definition_commits:Object.fromEntries(Object.keys(obligations).map(k=>[k,'c'])),
  };
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
      effect:desiredFor?{
        resource:'github-status:1:deadbeef:overcenter-runtime',
        desired:o.postcondition.expected_state,
        same_desired_commutes:true,
      }:null,
    })),
    lifecycles:Object.keys(obligations).map((obligation_id,i)=>({
      obligation_id,
      status:i===size-1?'UNREALIZED':'DONE',
    })),
  };
  const edgeCount=Object.values(obligations)
    .reduce((sum:number,o:any)=>sum+o.dependencies.length,0);
  return {state,lifecycles,targetId,request,edgeCount};
}

function chain(size:number){
  return buildFixture(size,'chain',i=>i===0?[]:[i-1]);
}

function fanIn(size:number){
  return buildFixture(size,'fan-in',i=>i===size-1
    ?Array.from({length:i},(_,j)=>j)
    :[]);
}

function fanOut(size:number){
  return buildFixture(size,'fan-out',i=>i===0?[]:[0]);
}

function layered(size:number){
  const width=Math.max(2,Math.floor(Math.sqrt(size)));
  return buildFixture(size,'layered',i=>{
    if(i<width)return [];
    const priorStart=Math.max(0,i-width);
    return [0,1,2,3]
      .map(offset=>priorStart+((i+offset)%width))
      .filter(upstream=>upstream<i);
  });
}

function dense(size:number){
  return buildFixture(size,'dense',i=>Array.from({length:i},(_,j)=>j));
}

function orderedEffects(size:number){
  return buildFixture(
    size,
    'ordered-effects',
    i=>i===0?[]:[i-1],
    i=>i%2===0?'success':'failure',
  );
}

function unorderedEffects(size:number){
  return buildFixture(
    size,
    'unordered-effects',
    _=>[],
    i=>i===size-2?'failure':'success',
  );
}

function tsAdmitted(f:any){
  try{validateAdmission(f.state);}catch{return false;}
  const target=f.state.obligations[f.targetId];
  if(claimabilityError(f.state,target,f.lifecycles))return false;
  return obligationKey(f.state,target,f.lifecycles,new Map())!==null;
}

function timed<T>(fn:()=>T){
  const started=performance.now();
  const value=fn();
  return {ms:performance.now()-started,value};
}

class Server{
  child=spawn(server,[],{stdio:['pipe','pipe','pipe']});
  buf='';
  pending:Array<(line:string)=>void>=[];
  constructor(){
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      this.buf+=chunk;
      for(;;){
        const i=this.buf.indexOf('\n');
        if(i<0)break;
        const line=this.buf.slice(0,i);
        this.buf=this.buf.slice(i+1);
        this.pending.shift()?.(line);
      }
    });
  }
  async request(req:unknown){
    const started=performance.now();
    const line=await new Promise<string>(resolve=>{
      this.pending.push(resolve);
      this.child.stdin.write(JSON.stringify(req)+'\n');
    });
    return {ms:performance.now()-started,value:JSON.parse(line)};
  }
  async close(){
    this.child.stdin.end();
    await once(this.child,'exit');
  }
}

async function runCase(
  p:Server,
  topology:string,
  size:number,
  fixture:any,
  expected:boolean,
){
  const ts=timed(()=>tsAdmitted(fixture));
  const persistent=await p.request(fixture.request);
  const shot=timed(()=>JSON.parse(execFileSync(oneShot,[],{
    input:JSON.stringify(fixture.request),
    encoding:'utf8',
    timeout:60_000,
    maxBuffer:64*1024*1024,
  })));

  if(ts.value!==expected)throw new Error(
    `TypeScript parity failure topology=${topology} size=${size} expected=${expected} actual=${ts.value}`,
  );
  if(persistent.value.admitted!==expected)throw new Error(
    `Lean persistent parity failure topology=${topology} size=${size}`,
  );
  if(shot.value.admitted!==expected)throw new Error(
    `Lean one-shot parity failure topology=${topology} size=${size}`,
  );

  console.log('TOPOLOGY_ROW '+JSON.stringify({
    topology,
    obligations:size,
    edges:fixture.edgeCount,
    expected_admitted:expected,
    typescript_ms:ts.ms,
    lean_persistent_ms:persistent.ms,
    lean_one_shot_ms:shot.ms,
  }));
}

const p=new Server();
try{
  for(const size of [100,400,1000]){
    await runCase(p,'chain',size,chain(size),true);
    await runCase(p,'fan-in',size,fanIn(size),true);
    await runCase(p,'fan-out',size,fanOut(size),true);
    await runCase(p,'layered',size,layered(size),true);
  }
  for(const size of [25,50,100,200]){
    await runCase(p,'dense',size,dense(size),true);
  }
  for(const size of [25,50,100,200,400]){
    await runCase(p,'ordered-effects',size,orderedEffects(size),true);
  }
  for(const size of [25,100,400]){
    await runCase(p,'unordered-effects',size,unorderedEffects(size),false);
  }
}finally{
  await p.close();
}
