import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';

import type { State } from '../../src/facts.ts';
import type { Obligation } from '../../src/model.ts';
import { validateGraph } from '../../src/graph.ts';

const oneShotBin=process.env.LEAN_ONE_SHOT_BIN
  ?? './lean-reference/experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmission';
const persistentBin=process.env.LEAN_PERSISTENT_BIN
  ?? './lean-reference/experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmissionServer';

const replaySize=100;

function obligation(id:string,upstream:string|null):Obligation {
  return {
    id,
    dependencies:upstream
      ? [{kind:'control',upstream}]
      : [],
    packet:{kind:'lean-authority-deletion-replay'},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:`/tmp/${id}`,
      content:id,
    },
  };
}

function statePrefix(size:number):State {
  const obligations:Record<string,Obligation>={};
  const definition_commits:Record<string,string>={};
  for(let i=0;i<size;i+=1){
    const id=`n-${String(i).padStart(4,'0')}`;
    const upstream=i===0?null:`n-${String(i-1).padStart(4,'0')}`;
    obligations[id]=obligation(id,upstream);
    definition_commits[id]=`definition-${i}`;
  }
  return {obligations,definition_commits};
}

function leanRequest(state:State){
  const obligations=Object.values(state.obligations);
  const target=obligations.at(-1);
  if(!target) throw new Error('EMPTY_REPLAY_PREFIX');
  return {
    command:'claim-admission',
    current_revision:'replay',
    expected_revision:'replay',
    target_id:target.id,
    obligations:obligations.map(item=>({
      id:item.id,
      dependencies:item.dependencies.map(edge=>({
        upstream:edge.upstream,
        kind:edge.kind,
        semantic_identity:edge.kind==='semantic'?'resolved':null,
      })),
      effect:null,
    })),
    lifecycles:obligations.map(item=>({
      obligation_id:item.id,
      status:item.id===target.id?'UNREALIZED':'DONE',
    })),
  };
}

function time<T>(fn:()=>T){
  const started=performance.now();
  const value=fn();
  return {elapsed_ms:performance.now()-started,value};
}

function validateTypeScript(state:State):boolean {
  try{
    validateGraph(state);
    return true;
  }catch{
    return false;
  }
}

function validateLeanOneShot(state:State):boolean {
  const output=execFileSync(oneShotBin,[],{
    input:JSON.stringify(leanRequest(state)),
    encoding:'utf8',
    timeout:60_000,
    maxBuffer:16*1024*1024,
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(output).admitted===true;
}

class PersistentLean {
  readonly child=spawn(persistentBin,[],{stdio:['pipe','pipe','pipe']});
  buffer='';
  stderr='';
  pending:Array<{
    resolve:(value:boolean)=>void;
    reject:(error:Error)=>void;
  }>=[];
  constructor(){
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',(chunk:string)=>{this.stderr+=chunk;});
    this.child.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      for(;;){
        const newline=this.buffer.indexOf('\n');
        if(newline<0)break;
        const line=this.buffer.slice(0,newline);
        this.buffer=this.buffer.slice(newline+1);
        const next=this.pending.shift();
        if(!next)continue;
        try{
          next.resolve(JSON.parse(line).admitted===true);
        }catch(error){
          next.reject(error as Error);
        }
      }
    });
    this.child.on('exit',(code)=>{
      if(code===0)return;
      const error=new Error(
        `persistent Lean exited ${code}: ${this.stderr}`,
      );
      for(const next of this.pending.splice(0))next.reject(error);
    });
  }
  request(state:State):Promise<boolean>{
    return new Promise((resolve,reject)=>{
      this.pending.push({resolve,reject});
      this.child.stdin.write(JSON.stringify(leanRequest(state))+'\n');
    });
  }
  async close(){
    this.child.stdin.end();
    const [code]=await once(this.child,'exit');
    if(code!==0)throw new Error(
      `persistent Lean exited ${code}: ${this.stderr}`,
    );
  }
}

const prefixes=Array.from(
  {length:replaySize},
  (_,i)=>statePrefix(i+1),
);

const tsResult=time(()=>{
  for(const [index,state] of prefixes.entries()){
    if(!validateTypeScript(state)){
      throw new Error(`TypeScript rejected valid prefix ${index+1}`);
    }
  }
});

const oneShotResult=time(()=>{
  for(const [index,state] of prefixes.entries()){
    if(!validateLeanOneShot(state)){
      throw new Error(`Lean one-shot rejected valid prefix ${index+1}`);
    }
  }
});

const persistent=new PersistentLean();
const persistentStarted=performance.now();
try{
  for(const [index,state] of prefixes.entries()){
    if(!await persistent.request(state)){
      throw new Error(`Lean persistent rejected valid prefix ${index+1}`);
    }
  }
}finally{
  await persistent.close();
}
const persistentElapsed=performance.now()-persistentStarted;

const unknownDependency:State={
  obligations:{
    broken:obligation('broken','missing'),
  },
  definition_commits:{broken:'broken-def'},
};

const cycle:State={
  obligations:{
    alpha:obligation('alpha','beta'),
    beta:obligation('beta','alpha'),
  },
  definition_commits:{alpha:'alpha-def',beta:'beta-def'},
};

const hostile={
  unknown_dependency:{
    typescript:validateTypeScript(unknownDependency),
    lean_one_shot:validateLeanOneShot(unknownDependency),
  },
  cycle:{
    typescript:validateTypeScript(cycle),
    lean_one_shot:validateLeanOneShot(cycle),
  },
};

const addedOneShotMs=oneShotResult.elapsed_ms-tsResult.elapsed_ms;
const gates={
  prefix_parity:true,
  unknown_dependency_fails_closed:
    hostile.unknown_dependency.typescript===false
    && hostile.unknown_dependency.lean_one_shot===false,
  cycle_fails_closed:
    hostile.cycle.typescript===false
    && hostile.cycle.lean_one_shot===false,
  one_shot_added_replay_ms_le_500:addedOneShotMs<=500,
};

const result={
  experiment:'current-main Lean graph authority deletion',
  exact_current_main:'1f6ad04704b3ed594c58ad5a5759be5048c3843d',
  exact_lean_reference:'0c5db60f2dc14af93f554fd9f870181261ce5f11',
  replay_prefixes:replaySize,
  typescript_replay_ms:tsResult.elapsed_ms,
  lean_one_shot_replay_ms:oneShotResult.elapsed_ms,
  lean_one_shot_added_ms:addedOneShotMs,
  lean_persistent_replay_ms:persistentElapsed,
  hostile,
  gates,
  drop_in_runtime_justified:Object.values(gates).every(Boolean),
};

console.log('LEAN_AUTHORITY_DELETION_RESULT='+JSON.stringify(result));

if(
  !gates.prefix_parity
  || !gates.unknown_dependency_fails_closed
  || !gates.cycle_fails_closed
){
  process.exitCode=2;
}
