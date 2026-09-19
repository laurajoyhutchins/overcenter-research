import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';

import { validateAdmission } from '../../src/admission.ts';
import { claimabilityError } from '../../src/eligibility.ts';
import { obligationKey } from '../../src/lifecycle.ts';

const oneShotKernel='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmission';
const serverKernel='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmissionServer';
const maxBuffer=64*1024*1024;
const timeoutMs=60_000;
const sizes=[1,10,100,1_000,10_000] as const;
const repetitions:Record<number,number>={
  1:100,
  10:80,
  100:50,
  1_000:20,
  10_000:5,
};

function idOf(i:number):string {
  return `obligation-${String(i).padStart(5,'0')}`;
}

function buildFixture(size:number) {
  const obligations:Record<string,any>={};
  const definition_commits:Record<string,string>={};
  const lifecycles=new Map<string,any>();

  for (let i=0;i<size;i+=1) {
    const id=idOf(i);
    obligations[id]={
      id,
      dependencies:[],
      packet:{kind:'lean-runtime-performance',sequence:i},
      postcondition:{
        verifier:'file-content-equals/v1',
        path:`/provider/${id}`,
        content:`content:${id}`,
      },
    };
    definition_commits[id]=`define:${id}`;
    lifecycles.set(id,{status:'UNREALIZED'});
  }

  const targetId=idOf(size-1);
  const state={obligations,definition_commits};
  const request={
    command:'claim-admission',
    current_revision:'r1',
    expected_revision:'r1',
    target_id:targetId,
    obligations:Object.values(obligations).map((obligation:any)=>({
      id:obligation.id,
      dependencies:[],
      effect:null,
    })),
    lifecycles:Object.keys(obligations).map(obligation_id=>({
      obligation_id,
      status:'UNREALIZED',
    })),
  };

  return {state,targetId,lifecycles,request};
}

function tsAdmitted(fixture:ReturnType<typeof buildFixture>):boolean {
  const {state,targetId,lifecycles}=fixture;
  try {
    validateAdmission(state as any);
  } catch {
    return false;
  }
  const target=(state as any).obligations[targetId];
  if (!target) return false;
  if (claimabilityError(state as any,target,lifecycles as any)) return false;
  return obligationKey(state as any,target,lifecycles as any,new Map())!==null;
}

function percentile(values:number[],p:number):number|null {
  if (values.length===0) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  const index=Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1));
  return sorted[index];
}

function stats(values:number[]) {
  const total=values.reduce((sum,value)=>sum+value,0);
  return {
    samples:values.length,
    min_ms:values.length?Math.min(...values):null,
    p50_ms:percentile(values,0.50),
    p95_ms:percentile(values,0.95),
    p99_ms:percentile(values,0.99),
    max_ms:values.length?Math.max(...values):null,
    mean_ms:values.length?total/values.length:null,
  };
}

function benchmarkTypeScript(fixture:ReturnType<typeof buildFixture>,reps:number) {
  for (let i=0;i<Math.min(10,reps);i+=1) {
    if (!tsAdmitted(fixture)) throw new Error('TypeScript unexpectedly rejected fixture');
  }
  const samples:number[]=[];
  for (let i=0;i<reps;i+=1) {
    const started=performance.now();
    const admitted=tsAdmitted(fixture);
    const elapsed=performance.now()-started;
    if (!admitted) throw new Error('TypeScript unexpectedly rejected fixture');
    samples.push(elapsed);
  }
  return stats(samples);
}

function runOneShot(request:unknown):{elapsed_ms:number;admitted:boolean} {
  const started=performance.now();
  const stdout=execFileSync(oneShotKernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    timeout:timeoutMs,
    maxBuffer,
    stdio:['pipe','pipe','pipe'],
  });
  const elapsed=performance.now()-started;
  const response=JSON.parse(stdout) as {admitted:boolean};
  return {elapsed_ms:elapsed,admitted:response.admitted};
}

function benchmarkOneShot(request:unknown,reps:number) {
  for (let i=0;i<Math.min(2,reps);i+=1) {
    const warmup=runOneShot(request);
    if (!warmup.admitted) throw new Error('Lean one-shot unexpectedly rejected fixture');
  }
  const samples:number[]=[];
  for (let i=0;i<reps;i+=1) {
    const result=runOneShot(request);
    if (!result.admitted) throw new Error('Lean one-shot unexpectedly rejected fixture');
    samples.push(result.elapsed_ms);
  }
  return stats(samples);
}

function oneShotMaxRssKb(request:unknown):number|null {
  const result=spawnSync('/usr/bin/time',['-f','MAXRSS_KB=%M',oneShotKernel],{
    input:JSON.stringify(request),
    encoding:'utf8',
    timeout:timeoutMs,
    maxBuffer,
  });
  if (result.error || result.status!==0) return null;
  const match=/MAXRSS_KB=(\d+)/.exec(result.stderr);
  return match?Number(match[1]):null;
}

function linuxProcessMemory(pid:number):{rss_kb:number|null;hwm_kb:number|null} {
  try {
    const status=readFileSync(`/proc/${pid}/status`,'utf8');
    const rss=/^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    const hwm=/^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    return {
      rss_kb:rss?Number(rss[1]):null,
      hwm_kb:hwm?Number(hwm[1]):null,
    };
  } catch {
    return {rss_kb:null,hwm_kb:null};
  }
}

class PersistentLean {
  child=spawn(serverKernel,[],{stdio:['pipe','pipe','pipe']});
  private buffer='';
  private pending:Array<{
    resolve:(line:string)=>void;
    reject:(error:Error)=>void;
  }>=[];
  private stderr='';

  constructor() {
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      for (;;) {
        const newline=this.buffer.indexOf('\n');
        if (newline<0) break;
        const line=this.buffer.slice(0,newline);
        this.buffer=this.buffer.slice(newline+1);
        const waiter=this.pending.shift();
        if (waiter) waiter.resolve(line);
      }
    });
    this.child.stderr.on('data',(chunk:string)=>{
      this.stderr+=chunk;
    });
    this.child.on('exit',(code,signal)=>{
      if (code===0 && this.pending.length===0) return;
      const error=new Error(
        `persistent Lean exited code=${code} signal=${signal} stderr=${this.stderr}`,
      );
      for (const waiter of this.pending.splice(0)) waiter.reject(error);
    });
  }

  async request(request:unknown):Promise<{elapsed_ms:number;admitted:boolean}> {
    if (!this.child.pid) throw new Error('persistent Lean has no pid');
    const started=performance.now();
    const linePromise=new Promise<string>((resolve,reject)=>{
      this.pending.push({resolve,reject});
      this.child.stdin.write(JSON.stringify(request)+'\n');
    });
    let timer:NodeJS.Timeout|undefined;
    try {
      const line=await Promise.race([
        linePromise,
        new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('persistent Lean request timed out')),timeoutMs);
        }),
      ]);
      const elapsed=performance.now()-started;
      const response=JSON.parse(line) as {admitted:boolean};
      return {elapsed_ms:elapsed,admitted:response.admitted};
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  memory() {
    return this.child.pid
      ? linuxProcessMemory(this.child.pid)
      : {rss_kb:null,hwm_kb:null};
  }

  async close():Promise<void> {
    if (this.child.exitCode!==null) return;
    this.child.stdin.end();
    await once(this.child,'exit');
  }

  kill():void {
    this.child.kill('SIGKILL');
  }
}

async function benchmarkPersistent(
  server:PersistentLean,
  request:unknown,
  reps:number,
) {
  for (let i=0;i<Math.min(10,reps);i+=1) {
    const warmup=await server.request(request);
    if (!warmup.admitted) throw new Error('persistent Lean unexpectedly rejected fixture');
  }
  const samples:number[]=[];
  for (let i=0;i<reps;i+=1) {
    const result=await server.request(request);
    if (!result.admitted) throw new Error('persistent Lean unexpectedly rejected fixture');
    samples.push(result.elapsed_ms);
  }
  return stats(samples);
}

function safe<T>(fn:()=>T):{ok:true;value:T}|{ok:false;error:string} {
  try {
    return {ok:true,value:fn()};
  } catch (error) {
    return {ok:false,error:error instanceof Error?error.message:String(error)};
  }
}

async function safeAsync<T>(fn:()=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;error:string}> {
  try {
    return {ok:true,value:await fn()};
  } catch (error) {
    return {ok:false,error:error instanceof Error?error.message:String(error)};
  }
}

const results:any[]=[];
const persistent=new PersistentLean();
let persistentAlive=true;

try {
  for (const size of sizes) {
    const fixture=buildFixture(size);
    const reps=repetitions[size];
    const requestBytes=Buffer.byteLength(JSON.stringify(fixture.request));

    const ts=safe(()=>benchmarkTypeScript(fixture,reps));
    const oneShot=safe(()=>benchmarkOneShot(fixture.request,reps));
    const oneShotRss=safe(()=>oneShotMaxRssKb(fixture.request));

    let persistentResult:{ok:true;value:any}|{ok:false;error:string};
    let persistentMemory={rss_kb:null as number|null,hwm_kb:null as number|null};
    if (persistentAlive) {
      persistentResult=await safeAsync(()=>benchmarkPersistent(persistent,fixture.request,reps));
      if (!persistentResult.ok) {
        persistentAlive=false;
        persistent.kill();
      } else {
        persistentMemory=persistent.memory();
      }
    } else {
      persistentResult={ok:false,error:'persistent server unavailable after prior failure'};
    }

    const row={
      obligations:size,
      repetitions:reps,
      request_bytes:requestBytes,
      typescript:ts,
      lean_one_shot:oneShot,
      lean_one_shot_max_rss_kb:oneShotRss,
      lean_persistent:persistentResult,
      lean_persistent_memory:persistentMemory,
      harness_rss_kb:Math.round(process.memoryUsage().rss/1024),
    };
    results.push(row);
    console.log('BENCHMARK_ROW '+JSON.stringify(row));
  }
} finally {
  if (persistentAlive) await persistent.close();
}

const productionRow=results.find(row=>row.obligations===1_000);
const correctness=results.every(row=>
  row.typescript.ok
  && row.lean_one_shot.ok
  && row.lean_persistent.ok
);
const oneShotP95=productionRow?.lean_one_shot?.ok
  ? productionRow.lean_one_shot.value.p95_ms
  : null;
const persistentP95=productionRow?.lean_persistent?.ok
  ? productionRow.lean_persistent.value.p95_ms
  : null;
const maxRssKb=productionRow?.lean_one_shot_max_rss_kb?.ok
  ? productionRow.lean_one_shot_max_rss_kb.value
  : null;

const gates={
  correctness,
  one_shot_p95_le_50ms:oneShotP95!==null && oneShotP95<=50,
  persistent_p95_le_20ms:persistentP95!==null && persistentP95<=20,
  one_shot_max_rss_le_128mb:maxRssKb!==null && maxRssKb<=128*1024,
};
const productionJustified=Object.values(gates).every(Boolean);
const summary={
  exact_experiment:'lean claim admission runtime performance',
  production_gate_obligations:1_000,
  stress_obligations:10_000,
  gates,
  production_justified:productionJustified,
  results,
};
console.log('BENCHMARK_RESULT_JSON='+JSON.stringify(summary));

if (!correctness) process.exitCode=2;
