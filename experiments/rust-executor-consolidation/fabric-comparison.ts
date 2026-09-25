import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

import {
  COMPUTATION_EXECUTION_SCHEMA,
  EXECUTOR_COMMAND_SCHEMA,
  PROCESS_SPEC_SCHEMA,
  assertComputationEvidenceFor,
  encodeProcessSpec,
  validateComputationEvidence,
  type ComputationAttemptEvidence,
  type ComputationExecution,
  type ProcessSpec,
} from '../../src/execution/protocol.ts';
import {
  bootstrapMedianUpperBound,
  median,
  pairedRatios,
} from '../../scripts/experiment-statistics.ts';
import { RustComputationExecutor } from './rust-computation-executor.ts';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{
  const [key,...rest]=value.replace(/^--/u,'').split('=');
  return [key,rest.join('=')];
}));

const goBinary=args.go;
const rustBinary=args.rust;
const goCgroup=args['go-cgroup'];
const rustCgroup=args['rust-cgroup'];
const workspace=args.workspace;
const semanticReportPath=args['semantic-report'];
if (!goBinary || !rustBinary || !goCgroup || !rustCgroup || !workspace || !semanticReportPath) {
  throw new Error(
    'usage: fabric-comparison.ts --go=... --rust=... --go-cgroup=... '
    +'--rust-cgroup=... --workspace=... --semantic-report=...',
  );
}

const sha256=(value:string):string=>createHash('sha256').update(value).digest('hex');
const context='sha256:'+sha256('rust-executor-consolidation-fabric-context');
let sequence=0;

function execution(spec:ProcessSpec):ComputationExecution {
  const index=sequence++;
  const encoded=encodeProcessSpec(spec);
  const capability='fabric-capability-'+index;
  return {
    schema:COMPUTATION_EXECUTION_SCHEMA,
    run_id:'fabric-run-'+index,
    obligation_id:'fabric-obligation-'+index,
    claimed_revision:'fabric-revision-'+index,
    execution_generation:1,
    execution_authority_commit:'fabric-authority-'+index,
    execution_capability:capability,
    execution_capability_sha256:sha256(capability),
    execution_spec_base64:encoded.base64,
    execution_spec_sha256:encoded.sha256,
  };
}

function processSpec(
  executable:string,
  argv:string[],
  options:Partial<ProcessSpec>={},
):ProcessSpec {
  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable,
    argv,
    cwd:'.',
    env:{},
    timeout_ms:10_000,
    stdout_max_bytes:4096,
    stderr_max_bytes:4096,
    ...options,
  };
}

class GoFabricExecutor {
  readonly #child:ChildProcessWithoutNullStreams;
  readonly #pending=new Map<string,{
    resolve:(evidence:ComputationAttemptEvidence)=>void;
    reject:(error:Error)=>void;
    execution:ComputationExecution;
  }>();
  #stderr='';
  #exited=false;

  constructor(concurrency:number) {
    this.#child=spawn(goBinary!,[
      '--stdio',
      '--workspace-root='+workspace,
      '--concurrency='+concurrency,
      '--unsafe-test-same-uid',
    ],{stdio:['pipe','pipe','pipe']});

    if (this.#child.pid===undefined) throw new Error('GO_EXECUTOR_PID_MISSING');
    fs.writeFileSync(path.join(goCgroup!,'cgroup.procs'),String(this.#child.pid));

    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data',chunk=>{this.#stderr+=String(chunk);});
    const lines=createInterface({input:this.#child.stdout,crlfDelay:Infinity});
    lines.on('line',line=>{
      let evidence:ComputationAttemptEvidence;
      try {
        evidence=validateComputationEvidence(JSON.parse(line));
      } catch (error) {
        this.#rejectAll(error instanceof Error?error:new Error(String(error)));
        return;
      }
      const pending=this.#pending.get(evidence.run_id);
      if (!pending) {
        this.#rejectAll(new Error('unexpected Go evidence for '+evidence.run_id));
        return;
      }
      this.#pending.delete(evidence.run_id);
      try {
        assertComputationEvidenceFor(evidence,pending.execution);
        pending.resolve(evidence);
      } catch (error) {
        pending.reject(error instanceof Error?error:new Error(String(error)));
      }
    });
    this.#child.once('exit',code=>{
      this.#exited=true;
      if (code!==0 || this.#pending.size>0) {
        this.#rejectAll(new Error('Go executor exited '+code+': '+this.#stderr));
      }
    });
  }

  #rejectAll(error:Error):void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async execute(item:ComputationExecution):Promise<ComputationAttemptEvidence> {
    if (this.#exited) throw new Error('GO_EXECUTOR_ALREADY_EXITED');
    return await new Promise((resolve,reject)=>{
      this.#pending.set(item.run_id,{resolve,reject,execution:item});
      this.#child.stdin.write(JSON.stringify({
        schema:EXECUTOR_COMMAND_SCHEMA,
        kind:'execute',
        execution:item,
      })+'\n');
    });
  }

  async abortPending():Promise<void> {
    if (this.#pending.size===0) return;
    this.#child.kill('SIGKILL');
    this.#rejectAll(new Error('GO_EXECUTOR_ABORTED_AFTER_STRESS_FAILURE'));
    if (this.#child.exitCode!==null) return;
    await new Promise<void>((resolve)=>{
      this.#child.once('exit',()=>resolve());
    });
  }

  async close():Promise<void> {
    assert.equal(this.#pending.size,0,'cannot close Go executor with work in flight');
    this.#child.stdin.end();
    if (this.#child.exitCode!==null) {
      assert.equal(this.#child.exitCode,0,'Go executor did not exit cleanly');
      return;
    }
    await new Promise<void>((resolve,reject)=>{
      this.#child.once('exit',code=>{
        if (code===0) resolve();
        else reject(new Error('Go executor exit '+code+': '+this.#stderr));
      });
    });
  }
}

interface Measurement {
  elapsed_ms:number;
  throughput_per_second:number;
  p50_ms:number;
  p95_ms:number;
  p99_ms:number;
  completed:number;
  cancelled:number;
}

interface Executor {
  execute:(item:ComputationExecution)=>Promise<ComputationAttemptEvidence>;
}

function percentile(values:number[],fraction:number):number {
  assert(values.length>0);
  const ordered=[...values].sort((a,b)=>a-b);
  const index=Math.min(ordered.length-1,Math.max(0,Math.ceil(ordered.length*fraction)-1));
  return ordered[index]!;
}

async function runBounded(
  executor:Executor,
  concurrency:number,
  total:number,
  specFor:(index:number)=>ProcessSpec,
  expectedFor:(index:number)=>ComputationAttemptEvidence['outcome']=()=> 'completed',
):Promise<Measurement> {
  let cursor=0;
  let completed=0;
  let cancelled=0;
  const latencies:number[]=[];
  const started=performance.now();

  const workers=Array.from({length:Math.min(concurrency,total)},async()=>{
    while (true) {
      const index=cursor++;
      if (index>=total) return;
      const attemptStarted=performance.now();
      const evidence=await executor.execute(execution(specFor(index)));
      latencies.push(performance.now()-attemptStarted);
      const expected=expectedFor(index);
      if (evidence.outcome!==expected) {
        throw new Error(
          'UNEXPECTED_OUTCOME:'+JSON.stringify({index,expected,evidence}),
        );
      }
      if (evidence.outcome==='completed') completed+=1;
      if (evidence.outcome==='cancelled') cancelled+=1;
    }
  });
  await Promise.all(workers);
  const elapsed=performance.now()-started;
  return {
    elapsed_ms:elapsed,
    throughput_per_second:total*1000/elapsed,
    p50_ms:percentile(latencies,0.50),
    p95_ms:percentile(latencies,0.95),
    p99_ms:percentile(latencies,0.99),
    completed,
    cancelled,
  };
}

const rust=new RustComputationExecutor({
  launcher:rustBinary,
  cgroupParent:rustCgroup,
  workspace,
  executionContextSha256:context,
});

const concurrencies=[1,8,32,128] as const;
const profiles=[
  {
    name:'noop',
    total:1024,
    threshold:1.25,
    spec:(_index:number)=>processSpec('/bin/true',[]),
  },
  {
    name:'sleep-10ms',
    total:512,
    threshold:1.25,
    spec:(_index:number)=>processSpec('/usr/bin/sleep',['0.01']),
  },
  {
    name:'sleep-100ms',
    total:256,
    threshold:1.10,
    spec:(_index:number)=>processSpec('/usr/bin/sleep',['0.1']),
  },
  {
    name:'mixed',
    total:64,
    threshold:1.10,
    spec:(index:number)=>{
      switch (index%4) {
        case 0: return processSpec('/bin/true',[]);
        case 1: return processSpec('/usr/bin/sleep',['0.01']);
        case 2: return processSpec('/usr/bin/sleep',['0.1']);
        default: return processSpec('/usr/bin/sleep',['1']);
      }
    },
  },
] as const;

const confirmatoryRounds=9;
const bootstrapConfidence=0.95;
const bootstrapResamples=20_000;

interface RatioInference {
  paired_ratios:number[];
  median_ratio:number;
  upper_bound:number;
  confidence:number;
  resamples:number;
}

function summarizeMeasurements(measurements:readonly Measurement[]):Measurement {
  assert(measurements.length>0);
  return {
    elapsed_ms:median(measurements.map(item=>item.elapsed_ms)),
    throughput_per_second:median(measurements.map(item=>item.throughput_per_second)),
    p50_ms:median(measurements.map(item=>item.p50_ms)),
    p95_ms:median(measurements.map(item=>item.p95_ms)),
    p99_ms:median(measurements.map(item=>item.p99_ms)),
    completed:Math.round(median(measurements.map(item=>item.completed))),
    cancelled:Math.round(median(measurements.map(item=>item.cancelled))),
  };
}

function upperRatioInference(
  baseline:readonly number[],
  treatment:readonly number[],
):RatioInference {
  const ratios=pairedRatios(baseline,treatment);
  const bound=bootstrapMedianUpperBound(ratios,{
    confidence:bootstrapConfidence,
    resamples:bootstrapResamples,
  });
  return {
    paired_ratios:ratios,
    median_ratio:median(ratios),
    upper_bound:bound.upper,
    confidence:bound.confidence,
    resamples:bound.resamples,
  };
}

const rows:Array<{
  concurrency:number;
  profile:string;
  threshold:number;
  go:Measurement;
  rust:Measurement;
  go_throughput_advantage:number;
  rust_p95_ratio:number;
  gate_applies:boolean;
  paired_rounds:number;
  architecture_order:string[];
  inference:null|{
    go_throughput_advantage:RatioInference;
    rust_p95_ratio:RatioInference;
  };
  pass:boolean;
}>=[];

for (const concurrency of concurrencies) {
  const go=new GoFabricExecutor(concurrency);
  let goFailed=false;
  try {
    const warmup=Math.min(32,Math.max(2,concurrency*2));
    await runBounded(go,concurrency,warmup,()=>processSpec('/bin/true',[]));
    await runBounded(rust,concurrency,warmup,()=>processSpec('/bin/true',[]));

    for (const [profileIndex,profile] of profiles.entries()) {
      const gateApplies=concurrency>=32;
      const rounds=gateApplies?confirmatoryRounds:1;
      const goMeasurements:Measurement[]=[];
      const rustMeasurements:Measurement[]=[];
      const architectureOrder:string[]=[];

      const runGo=async():Promise<Measurement>=>{
        try {
          return await runBounded(go,concurrency,profile.total,profile.spec);
        } catch (error) {
          throw new Error(
            `GO_PROFILE_FAILURE:concurrency=${concurrency}:profile=${profile.name}:${String(error)}`,
          );
        }
      };
      const runRust=async():Promise<Measurement>=>{
        try {
          return await runBounded(rust,concurrency,profile.total,profile.spec);
        } catch (error) {
          throw new Error(
            `RUST_PROFILE_FAILURE:concurrency=${concurrency}:profile=${profile.name}:${String(error)}`,
          );
        }
      };

      for (let round=0;round<rounds;round+=1) {
        const goFirst=(round+profileIndex)%2===0;
        let goMeasurement:Measurement;
        let rustMeasurement:Measurement;
        if (goFirst) {
          goMeasurement=await runGo();
          rustMeasurement=await runRust();
          architectureOrder.push('go-rust');
        } else {
          rustMeasurement=await runRust();
          goMeasurement=await runGo();
          architectureOrder.push('rust-go');
        }
        goMeasurements.push(goMeasurement);
        rustMeasurements.push(rustMeasurement);
      }

      const goSummary=summarizeMeasurements(goMeasurements);
      const rustSummary=summarizeMeasurements(rustMeasurements);
      const throughputRatios=pairedRatios(
        rustMeasurements.map(item=>item.throughput_per_second),
        goMeasurements.map(item=>item.throughput_per_second),
      );
      const p95Ratios=pairedRatios(
        goMeasurements.map(item=>item.p95_ms),
        rustMeasurements.map(item=>item.p95_ms),
      );
      const inference=gateApplies?{
        go_throughput_advantage:upperRatioInference(
          rustMeasurements.map(item=>item.throughput_per_second),
          goMeasurements.map(item=>item.throughput_per_second),
        ),
        rust_p95_ratio:upperRatioInference(
          goMeasurements.map(item=>item.p95_ms),
          rustMeasurements.map(item=>item.p95_ms),
        ),
      }:null;
      const pass=inference===null || (
        inference.go_throughput_advantage.upper_bound<=profile.threshold
        && inference.rust_p95_ratio.upper_bound<=profile.threshold
      );

      rows.push({
        concurrency,
        profile:profile.name,
        threshold:profile.threshold,
        go:goSummary,
        rust:rustSummary,
        go_throughput_advantage:median(throughputRatios),
        rust_p95_ratio:median(p95Ratios),
        gate_applies:gateApplies,
        paired_rounds:rounds,
        architecture_order:architectureOrder,
        inference,
        pass,
      });
    }
  } catch (error) {
    goFailed=true;
    throw error;
  } finally {
    if (goFailed) await go.abortPending();
    else await go.close();
  }
}

const retentionConcurrency=64;
const retentionBlocks=5;
const retentionBlockTotal=4_000;
const retentionTotal=retentionBlocks*retentionBlockTotal;
const goRetentionExecutor=new GoFabricExecutor(retentionConcurrency);
const goRetentionMeasurements:Measurement[]=[];
const rustRetentionMeasurements:Measurement[]=[];
const retentionArchitectureOrder:string[]=[];
let goRetentionFailed=false;
try {
  for (let block=0;block<retentionBlocks;block+=1) {
    const runGo=()=>runBounded(
      goRetentionExecutor,
      retentionConcurrency,
      retentionBlockTotal,
      ()=>processSpec('/bin/true',[]),
    );
    const runRust=()=>runBounded(
      rust,
      retentionConcurrency,
      retentionBlockTotal,
      ()=>processSpec('/bin/true',[]),
    );
    const goFirst=block%2===0;
    let goMeasurement:Measurement;
    let rustMeasurement:Measurement;
    if (goFirst) {
      goMeasurement=await runGo();
      rustMeasurement=await runRust();
      retentionArchitectureOrder.push('go-rust');
    } else {
      rustMeasurement=await runRust();
      goMeasurement=await runGo();
      retentionArchitectureOrder.push('rust-go');
    }
    goRetentionMeasurements.push(goMeasurement);
    rustRetentionMeasurements.push(rustMeasurement);
  }
} catch (error) {
  goRetentionFailed=true;
  throw error;
} finally {
  if (goRetentionFailed) await goRetentionExecutor.abortPending();
  else await goRetentionExecutor.close();
}
const goRetention=summarizeMeasurements(goRetentionMeasurements);
const rustRetention=summarizeMeasurements(rustRetentionMeasurements);
const retentionThroughputInference=upperRatioInference(
  rustRetentionMeasurements.map(item=>item.throughput_per_second),
  goRetentionMeasurements.map(item=>item.throughput_per_second),
);
const retentionGoThroughputAdvantage=retentionThroughputInference.median_ratio;
const retentionRustP95Ratios=pairedRatios(
  goRetentionMeasurements.map(item=>item.p95_ms),
  rustRetentionMeasurements.map(item=>item.p95_ms),
);
const retentionRustP95Ratio=median(retentionRustP95Ratios);

async function cancellationStress(executor:Executor):Promise<Measurement> {
  return await runBounded(
    executor,
    32,
    64,
    index=>index%8===0
      ? processSpec('/bin/sh',['-c','while :; do :; done'],{timeout_ms:30})
      : processSpec('/usr/bin/sleep',['0.01']),
    index=>index%8===0?'cancelled':'completed',
  );
}

const goStressExecutor=new GoFabricExecutor(32);
let goStress:Measurement;
let goStressFailed=false;
try {
  goStress=await cancellationStress(goStressExecutor);
  const probe=await goStressExecutor.execute(execution(processSpec('/bin/true',[])));
  assert.equal(probe.outcome,'completed','Go fabric unusable after concurrent cancellation');
} catch (error) {
  goStressFailed=true;
  throw error;
} finally {
  if (goStressFailed) await goStressExecutor.abortPending();
  else await goStressExecutor.close();
}

const rustStress=await cancellationStress(rust);
const rustProbe=await rust.execute(execution(processSpec('/bin/true',[])));
assert.equal(rustProbe.outcome,'completed','Rust direct path unusable after concurrent cancellation');

const readCounter=(dir:string,file:string):number=>{
  const value=Number(fs.readFileSync(path.join(dir,file),'utf8').trim());
  assert(Number.isFinite(value) && value>=0,'invalid cgroup counter '+dir+'/'+file);
  return value;
};
const goPeak=readCounter(goCgroup,'memory.peak');
const rustPeak=readCounter(rustCgroup,'memory.peak');
const memoryRatio=rustPeak/goPeak;

const semantic=JSON.parse(fs.readFileSync(semanticReportPath,'utf8')) as {
  gates?:Record<string,boolean>;
  deletion_supported?:boolean;
};

const semanticPass=
  semantic.gates?.parity===true
  && semantic.gates?.catastrophic_recovery===true
  && semantic.gates?.simplification===true;
const fabricPerformancePass=rows.filter(row=>row.gate_applies).every(row=>row.pass);
const retentionScalePass=retentionThroughputInference.upper_bound<2;
const memoryPass=memoryRatio<=1.25;
const cancellationPass=
  goStress.cancelled===8
  && goStress.completed===56
  && rustStress.cancelled===8
  && rustStress.completed===56;

const report={
  schema:'overcenter-executor-fabric-retention-result-v1',
  prior_serial_phase:{
    result:semantic,
    architectural_conclusion_valid:false,
    reason:
      'The prior phase established semantic viability and per-attempt cost only; '
      +'it did not exercise the long-lived Go executor as a concurrent fabric.',
  },
  concurrent_fabric:{
    execution_envelope:{
      cpu_quota:'4 CPUs',
      memory_max_bytes:2147483648,
      pids_max:4096,
      concurrency_levels:concurrencies,
    },
    profiles:rows,
    retention_scale:{
      envelope_count:retentionTotal,
      paired_blocks:retentionBlocks,
      envelope_count_per_block:retentionBlockTotal,
      concurrency:retentionConcurrency,
      architecture_order:retentionArchitectureOrder,
      go:goRetention,
      rust:rustRetention,
      go_throughput_advantage:retentionGoThroughputAdvantage,
      go_throughput_advantage_inference:retentionThroughputInference,
      rust_p95_ratio:retentionRustP95Ratio,
      rust_p95_paired_ratios:retentionRustP95Ratios,
      original_material_threshold:2,
      pass:retentionScalePass,
    },
    cancellation_stress:{
      concurrency:32,
      total:64,
      timeout_jobs:8,
      go:goStress,
      rust:rustStress,
    },
    peak_memory_bytes:{
      go:goPeak,
      rust:rustPeak,
      rust_over_go:memoryRatio,
      maximum_allowed_ratio:1.25,
    },
  },
  gates:{
    semantic_and_recovery:semanticPass,
    concurrent_throughput_and_p95:fabricPerformancePass,
    original_scale_retention:retentionScalePass,
    concurrent_peak_memory:memoryPass,
    concurrent_cancellation:cancellationPass,
  },
  deletion_supported:
    semanticPass
    && fabricPerformancePass
    && retentionScalePass
    && memoryPass
    && cancellationPass,
};
console.log(JSON.stringify(report,null,2));
