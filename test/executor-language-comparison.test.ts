import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import {
  executeStream as executeTypeScriptStream,
  type TypeScriptRunner,
} from '../experiments/executor-language-comparison/typescript-executor.ts';
import type {
  GraphExecutionEnvelope,
  GraphExecutionEvidence,
} from '../experiments/go-graph-executor/adapter.ts';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const goDir=join(repoRoot,'experiments/go-graph-executor');
const fixture=join(repoRoot,'experiments/executor-language-comparison/child-task.mjs');
const tsCli=join(repoRoot,'experiments/executor-language-comparison/typescript-cli.ts');
const scratch=mkdtempSync(join(tmpdir(),'overcenter-language-comparison-'));
const goSupervised=join(scratch,'go-supervised');
const goSynthetic=join(scratch,'go-synthetic');

execFileSync('go',['build','-o',goSupervised,'./cmd/execute-supervised'],{cwd:goDir,stdio:'inherit'});
execFileSync('go',['build','-o',goSynthetic,'./cmd/execute-stream'],{cwd:goDir,stdio:'inherit'});

after(()=>rmSync(scratch,{recursive:true,force:true}));

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

function envelope(
  index:number,
  executionSpec:unknown,
  overrides:Partial<GraphExecutionEnvelope>={},
):GraphExecutionEnvelope {
  const capability=`capability-${index}`;
  return {
    run_id:`run-${String(index).padStart(6,'0')}`,
    obligation_id:`obligation-${String(index).padStart(6,'0')}`,
    claimed_revision:`revision-${index}`,
    execution_generation:1,
    execution_authority_commit:`authority-${index}`,
    execution_capability:capability,
    execution_capability_sha256:digest(capability),
    execution_spec_sha256:'sha256:'+digest(JSON.stringify(executionSpec)),
    execution_spec:executionSpec,
    ...overrides,
  };
}

interface RunResult {
  code:number|null;
  stdout:string;
  stderr:string;
  elapsed_ms:number;
}

async function run(
  command:string,
  args:string[],
  envelopes:GraphExecutionEnvelope[],
  cwd=repoRoot,
):Promise<RunResult> {
  return await new Promise((resolve,reject)=>{
    const started=performance.now();
    const child=spawn(command,args,{cwd,stdio:['pipe','pipe','pipe']});
    let stdout='';
    let stderr='';
    const guard=setTimeout(()=>{
      child.kill('SIGKILL');
      reject(new Error(`executor guard timeout: ${command} ${args.join(' ')}`));
    },45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=String(chunk);});
    child.stderr.on('data',chunk=>{stderr+=String(chunk);});
    child.once('error',error=>{
      clearTimeout(guard);
      reject(error);
    });
    child.once('close',code=>{
      clearTimeout(guard);
      resolve({code,stdout,stderr,elapsed_ms:performance.now()-started});
    });
    child.stdin.end(envelopes.map(item=>JSON.stringify(item)).join('\n')+'\n');
  });
}

function parseEvidence(stdout:string):GraphExecutionEvidence[] {
  return stdout.trim()
    ? stdout.trim().split('\n').map(line=>JSON.parse(line) as GraphExecutionEvidence)
    : [];
}

function normalized(items:GraphExecutionEvidence[]):unknown[] {
  return items.map(item=>({
    schema:item.schema,
    run_id:item.run_id,
    obligation_id:item.obligation_id,
    claimed_revision:item.claimed_revision,
    execution_generation:item.execution_generation,
    execution_authority_commit:item.execution_authority_commit,
    execution_capability_sha256:item.execution_capability_sha256,
    effect_reservation_commit:item.effect_reservation_commit,
    execution_spec_sha256:item.execution_spec_sha256,
    outcome:item.outcome,
    output_base64:item.output_base64,
    output_sha256:item.output_sha256,
  })).sort((a,b)=>a.run_id.localeCompare(b.run_id));
}

function tsArgs({
  concurrency=4,
  timeoutMillis=10_000,
  runner='supervised',
}:{concurrency?:number;timeoutMillis?:number;runner?:'supervised'|'synthetic'}={}):string[] {
  return [
    '--experimental-strip-types',
    tsCli,
    `--runner=${runner}`,
    `--concurrency=${concurrency}`,
    `--timeout-ms=${timeoutMillis}`,
  ];
}

function processAlive(pid:number):boolean {
  try {
    process.kill(pid,0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code!=='ESRCH';
  }
}

async function assertPidsDie(files:string[]):Promise<void> {
  const pids=files.flatMap(file=>{
    assert.ok(existsSync(file),`missing pid file: ${file}`);
    return readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>{
      const pid=Number.parseInt(line.split(':')[1]??'',10);
      assert.ok(Number.isSafeInteger(pid),`invalid pid record: ${line}`);
      return pid;
    });
  });
  assert.equal(pids.length,files.length*2,'each hostile task should record parent and grandchild');

  const deadline=Date.now()+3000;
  while (Date.now()<deadline && pids.some(processAlive)) {
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const survivors=pids.filter(processAlive);
  assert.deepEqual(survivors,[],`orphan processes survived cancellation: ${survivors.join(',')}`);
}

test('Go and TypeScript produce equivalent evidence for the same completed stream',async()=>{
  const work=Array.from({length:24},(_,index)=>envelope(index,{
    fixture,
    mode:'complete',
    result:`result-${index}`,
  }));
  const [go,ts]=await Promise.all([
    run(goSupervised,['--concurrency=4','--timeout=10s'],work),
    run(process.execPath,tsArgs({concurrency:4}),work),
  ]);
  assert.equal(go.code,0,go.stderr);
  assert.equal(ts.code,0,ts.stderr);
  assert.deepEqual(normalized(parseEvidence(ts.stdout)),normalized(parseEvidence(go.stdout)));
});

test('TypeScript alternative independently enforces bounded concurrency',async()=>{
  const work=Array.from({length:40},(_,index)=>envelope(index,{result:String(index)}));
  let active=0;
  let peak=0;
  const runner:TypeScriptRunner=async()=>{
    active+=1;
    peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,8));
    active-=1;
    return Buffer.from('ok');
  };
  async function* source() {
    yield* work;
  }
  const evidence:GraphExecutionEvidence[]=[];
  for await (const item of executeTypeScriptStream(new AbortController().signal,source(),4,runner)) {
    evidence.push(item);
  }
  assert.equal(evidence.length,40);
  assert.equal(peak,4);
});

test('TypeScript rejects duplicate execution identity without running it twice',async()=>{
  const first=envelope(90,{result:'once'});
  const calls:{count:number}={count:0};
  const runner:TypeScriptRunner=async()=>{
    calls.count+=1;
    await new Promise(resolve=>setTimeout(resolve,10));
    return Buffer.from('once');
  };
  async function* source() {
    yield first;
    yield structuredClone(first);
  }
  await assert.rejects(async()=>{
    for await (const _item of executeTypeScriptStream(
      new AbortController().signal,
      source(),
      2,
      runner,
    )) {
      // Duplicate validation must terminate the stream before a second run.
    }
  },/duplicate execution identity/);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls.count,1);
});

test('both reject a forged spec digest before starting a child',async()=>{
  const pidFiles=[join(scratch,'forged-go.pid'),join(scratch,'forged-ts.pid')];
  const goWork=[envelope(100,{fixture,mode:'complete',result:'no',pid_file:pidFiles[0]},{
    execution_spec_sha256:'sha256:'+'0'.repeat(64),
  })];
  const tsWork=[envelope(101,{fixture,mode:'complete',result:'no',pid_file:pidFiles[1]},{
    execution_spec_sha256:'sha256:'+'0'.repeat(64),
  })];
  const [go,ts]=await Promise.all([
    run(goSupervised,['--concurrency=1','--timeout=5s'],goWork),
    run(process.execPath,tsArgs({concurrency:1}),tsWork),
  ]);
  assert.notEqual(go.code,0);
  assert.notEqual(ts.code,0);
  assert.equal(existsSync(pidFiles[0]),false,'Go started forged work');
  assert.equal(existsSync(pidFiles[1]),false,'TypeScript started forged work');
});

test('both escalate to SIGKILL when process trees ignore SIGTERM',async()=>{
  const goPidFiles=Array.from({length:2},(_,index)=>join(scratch,`go-ignore-term-${index}.pid`));
  const tsPidFiles=Array.from({length:2},(_,index)=>join(scratch,`ts-ignore-term-${index}.pid`));
  const goWork=goPidFiles.map((pidFile,index)=>envelope(400+index,{
    fixture,mode:'grandchild-ignore-term',pid_file:pidFile,
  }));
  const tsWork=tsPidFiles.map((pidFile,index)=>envelope(500+index,{
    fixture,mode:'grandchild-ignore-term',pid_file:pidFile,
  }));

  const [go,ts]=await Promise.all([
    run(goSupervised,['--concurrency=2','--timeout=800ms'],goWork),
    run(process.execPath,tsArgs({concurrency:2,timeoutMillis:800}),tsWork),
  ]);
  assert.equal(go.code,0,go.stderr);
  assert.equal(ts.code,0,ts.stderr);
  assert.ok(parseEvidence(go.stdout).every(item=>item.outcome==='cancelled'));
  assert.ok(parseEvidence(ts.stdout).every(item=>item.outcome==='cancelled'));
  await assertPidsDie(goPidFiles);
  await assertPidsDie(tsPidFiles);
});

test('both cancel process groups without orphaning grandchildren',async()=>{
  const goPidFiles=Array.from({length:4},(_,index)=>join(scratch,`go-tree-${index}.pid`));
  const tsPidFiles=Array.from({length:4},(_,index)=>join(scratch,`ts-tree-${index}.pid`));
  const goWork=goPidFiles.map((pidFile,index)=>envelope(200+index,{
    fixture,mode:'grandchild-hang',pid_file:pidFile,
  }));
  const tsWork=tsPidFiles.map((pidFile,index)=>envelope(300+index,{
    fixture,mode:'grandchild-hang',pid_file:pidFile,
  }));

  const [go,ts]=await Promise.all([
    run(goSupervised,['--concurrency=4','--timeout=800ms'],goWork),
    run(process.execPath,tsArgs({concurrency:4,timeoutMillis:800}),tsWork),
  ]);
  assert.equal(go.code,0,go.stderr);
  assert.equal(ts.code,0,ts.stderr);

  const goEvidence=parseEvidence(go.stdout);
  const tsEvidence=parseEvidence(ts.stdout);
  assert.equal(goEvidence.length,4);
  assert.equal(tsEvidence.length,4);
  assert.ok(goEvidence.every(item=>item.outcome==='cancelled'));
  assert.ok(tsEvidence.every(item=>item.outcome==='cancelled'));
  assert.ok(goEvidence.every(item=>!item.output_base64 && !item.output_sha256));
  assert.ok(tsEvidence.every(item=>!item.output_base64 && !item.output_sha256));

  await assertPidsDie(goPidFiles);
  await assertPidsDie(tsPidFiles);
});

function sourceLines(path:string):number {
  return readFileSync(path,'utf8').split('\n')
    .map(line=>line.trim())
    .filter(line=>line && !line.startsWith('//') && line!=='{' && line!=='}')
    .length;
}

async function timedRun(
  command:string,
  args:string[],
  work:GraphExecutionEnvelope[],
  metricFile:string,
):Promise<{elapsed_ms:number;max_rss_kb:number;code:number|null}> {
  rmSync(metricFile,{force:true});
  const result=await run(
    '/usr/bin/time',
    ['-f','%M','-o',metricFile,command,...args],
    work,
  );
  const maxRssKb=Number.parseInt(readFileSync(metricFile,'utf8').trim(),10);
  return {elapsed_ms:result.elapsed_ms,max_rss_kb:maxRssKb,code:result.code};
}

function median(values:number[]):number {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)];
}

test('report pre-registered 20,000-envelope operational comparison',async(t)=>{
  const count=20_000;
  const work=Array.from({length:count},(_,index)=>envelope(10_000+index,{
    delay_ms:1,
    result:'x',
  }));

  const goRuns=[];
  const tsRuns=[];
  for (let attempt=0;attempt<3;attempt+=1) {
    goRuns.push(await timedRun(
      goSynthetic,
      ['--concurrency=64','--timeout=30s'],
      work,
      join(scratch,`go-time-${attempt}.txt`),
    ));
    tsRuns.push(await timedRun(
      process.execPath,
      tsArgs({concurrency:64,timeoutMillis:30_000,runner:'synthetic'}),
      work,
      join(scratch,`ts-time-${attempt}.txt`),
    ));
  }
  assert.ok(goRuns.every(run=>run.code===0),JSON.stringify(goRuns));
  assert.ok(tsRuns.every(run=>run.code===0),JSON.stringify(tsRuns));

  const goElapsed=median(goRuns.map(run=>run.elapsed_ms));
  const tsElapsed=median(tsRuns.map(run=>run.elapsed_ms));
  const goRss=median(goRuns.map(run=>run.max_rss_kb));
  const tsRss=median(tsRuns.map(run=>run.max_rss_kb));
  const throughputRatio=tsElapsed/goElapsed;
  const memoryRatio=tsRss/goRss;

  const goRuntimeSloc=[
    join(goDir,'executor.go'),
    join(goDir,'stream.go'),
    join(goDir,'supervised.go'),
  ].reduce((sum,path)=>sum+sourceLines(path),0);
  const tsRuntimeSloc=sourceLines(
    join(repoRoot,'experiments/executor-language-comparison/typescript-executor.ts'),
  );

  const report={
    envelopes:count,
    attempts:3,
    go:{median_elapsed_ms:goElapsed,median_max_rss_kb:goRss,runtime_sloc:goRuntimeSloc},
    typescript:{median_elapsed_ms:tsElapsed,median_max_rss_kb:tsRss,runtime_sloc:tsRuntimeSloc},
    ratios:{
      go_throughput_advantage:throughputRatio,
      go_memory_advantage:memoryRatio,
    },
    pre_registered_material_threshold:2,
    go_crosses_material_threshold:throughputRatio>=2 || memoryRatio>=2,
  };
  t.diagnostic('COMPARISON_RESULT '+JSON.stringify(report));
});
