import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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
import { ConfinedWorkerRecoveryAuthority } from './confined-executor-treatment.ts';
import { RustComputationExecutor } from './rust-computation-executor.ts';

const args=Object.fromEntries(process.argv.slice(2).map(value=>{
  const [key,...rest]=value.replace(/^--/u,'').split('=');
  return [key,rest.join('=')];
}));
const goBinary=args.go;
const rustBinary=args.rust;
const cgroupParent=args.cgroup;
const workspace=args.workspace;
const descendantBinary=args.descendant;
if (!goBinary || !rustBinary || !cgroupParent || !workspace || !descendantBinary) {
  throw new Error('usage: comparison.ts --go=... --rust=... --cgroup=... --workspace=... --descendant=...');
}

const sha256=(value:string):string=>createHash('sha256').update(value).digest('hex');
const context='sha256:'+sha256('rust-executor-consolidation-context');
let sequence=0;

function execution(spec:ProcessSpec):ComputationExecution {
  const index=sequence++;
  const encoded=encodeProcessSpec(spec);
  const capability=`capability-${index}`;
  return {
    schema:COMPUTATION_EXECUTION_SCHEMA,
    run_id:`run-${index}`,
    obligation_id:`obligation-${index}`,
    claimed_revision:`revision-${index}`,
    execution_generation:1,
    execution_authority_commit:`authority-${index}`,
    execution_capability:capability,
    execution_capability_sha256:sha256(capability),
    execution_spec_base64:encoded.base64,
    execution_spec_sha256:encoded.sha256,
  };
}

class GoStdioExecutor {
  readonly #child:ChildProcessWithoutNullStreams;
  readonly #queue:Array<{
    resolve:(evidence:ComputationAttemptEvidence)=>void;
    reject:(error:Error)=>void;
    execution:ComputationExecution;
  }>=[];
  #stderr='';

  constructor() {
    this.#child=spawn(goBinary!,[
      '--stdio',
      `--workspace-root=${workspace}`,
      '--concurrency=1',
      '--unsafe-test-same-uid',
    ],{stdio:['pipe','pipe','pipe']});
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data',chunk=>{this.#stderr+=String(chunk);});
    const lines=createInterface({input:this.#child.stdout,crlfDelay:Infinity});
    lines.on('line',line=>{
      const pending=this.#queue.shift();
      if (!pending) throw new Error(`unexpected Go evidence: ${line}`);
      try {
        const evidence=validateComputationEvidence(JSON.parse(line));
        assertComputationEvidenceFor(evidence,pending.execution);
        pending.resolve(evidence);
      } catch (error) {
        pending.reject(error instanceof Error?error:new Error(String(error)));
      }
    });
    this.#child.once('exit',code=>{
      const error=new Error(`Go executor exited ${code}: ${this.#stderr}`);
      for (const pending of this.#queue.splice(0)) pending.reject(error);
    });
  }

  async execute(item:ComputationExecution):Promise<ComputationAttemptEvidence> {
    return await new Promise((resolve,reject)=>{
      this.#queue.push({resolve,reject,execution:item});
      this.#child.stdin.write(JSON.stringify({
        schema:EXECUTOR_COMMAND_SCHEMA,
        kind:'execute',
        execution:item,
      })+'\n');
    });
  }

  async close():Promise<void> {
    this.#child.stdin.end();
    if (this.#child.exitCode!==null) return;
    await new Promise<void>((resolve,reject)=>{
      this.#child.once('exit',code=>code===0?resolve():reject(new Error(`Go executor exit ${code}: ${this.#stderr}`)));
    });
  }
}

const rust=new RustComputationExecutor({
  launcher:rustBinary,
  cgroupParent,
  workspace,
  executionContextSha256:context,
});
const go=new GoStdioExecutor();

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

function comparable(evidence:ComputationAttemptEvidence):unknown {
  return {
    outcome:evidence.outcome,
    exit_code:evidence.exit_code,
    stdout_base64:evidence.stdout_base64,
    stdout_sha256:evidence.stdout_sha256,
    stdout_truncated:evidence.stdout_truncated,
    stderr_base64:evidence.stderr_base64,
    stderr_sha256:evidence.stderr_sha256,
    stderr_truncated:evidence.stderr_truncated,
  };
}

async function parityCase(name:string,spec:ProcessSpec):Promise<{name:string;pass:boolean;go:unknown;rust:unknown}> {
  const goExecution=execution(spec);
  const rustExecution=execution(spec);
  const [goEvidence,rustEvidence]=await Promise.all([
    go.execute(goExecution),
    rust.execute(rustExecution),
  ]);
  assertComputationEvidenceFor(goEvidence,goExecution);
  assertComputationEvidenceFor(rustEvidence,rustExecution);
  const left=comparable(goEvidence);
  const right=comparable(rustEvidence);
  return {name,pass:JSON.stringify(left)===JSON.stringify(right),go:left,rust:right};
}

async function median(samples:number,run:()=>Promise<void>):Promise<number> {
  const values:number[]=[];
  for (let index=0;index<3;index+=1) await run();
  for (let index=0;index<samples;index+=1) {
    const started=performance.now();
    await run();
    values.push(performance.now()-started);
  }
  values.sort((a,b)=>a-b);
  return values[Math.floor(values.length/2)]!;
}


async function proveCatastrophicRecovery():Promise<{
  pass:boolean;
  containment_id:string;
  populated_before_supervisor_death:boolean;
  absent_after_recovery:boolean;
}> {
  const script=fileURLToPath(new URL('./crash-supervisor.ts',import.meta.url));
  const supervisor=spawn(process.execPath,[
    '--experimental-strip-types',
    script,
    `--launcher=${rustBinary}`,
    `--cgroup=${cgroupParent}`,
    `--workspace=${workspace}`,
  ],{stdio:['ignore','pipe','pipe']});
  supervisor.stdout.setEncoding('utf8');
  supervisor.stderr.setEncoding('utf8');
  let stderr='';
  supervisor.stderr.on('data',chunk=>{stderr+=String(chunk);});

  const lines=createInterface({input:supervisor.stdout,crlfDelay:Infinity});
  const containmentId=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`RECOVERY_PROOF_ID_TIMEOUT:${stderr}`)),5000);
    lines.once('line',line=>{
      clearTimeout(timer);
      try {
        const parsed=JSON.parse(line) as {containment_id?:unknown};
        if (typeof parsed.containment_id!=='string') throw new Error('missing containment_id');
        resolve(parsed.containment_id);
      } catch (error) {
        reject(error);
      }
    });
    supervisor.once('exit',code=>{
      if (code!==null) {
        clearTimeout(timer);
        reject(new Error(`RECOVERY_PROOF_SUPERVISOR_EXITED:${code}:${stderr}`));
      }
    });
  });

  const fields=containmentId.split(':');
  assert.equal(fields.length,4);
  const leafName=fields[1]!;
  const leafPath=path.join(cgroupParent,leafName);
  const eventsPath=path.join(leafPath,'cgroup.events');

  let populated=false;
  for (let attempt=0;attempt<200;attempt+=1) {
    if (fs.existsSync(eventsPath)) {
      const events=fs.readFileSync(eventsPath,'utf8');
      if (/^populated 1$/mu.test(events)) {
        populated=true;
        break;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(populated,true,'worker never populated exact recovery cgroup');

  if (supervisor.exitCode!==null) {
    throw new Error(`RECOVERY_PROOF_SUPERVISOR_EXITED_BEFORE_CRASH:${supervisor.exitCode}:${stderr}`);
  }
  supervisor.kill('SIGKILL');
  if (supervisor.exitCode===null) {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('RECOVERY_PROOF_SUPERVISOR_KILL_TIMEOUT')),5000);
      supervisor.once('exit',()=>{
        clearTimeout(timer);
        resolve();
      });
    });
  }

  const authority=new ConfinedWorkerRecoveryAuthority(cgroupParent);
  await authority.assertTerminated(containmentId);
  const absent=!fs.existsSync(leafPath);
  return {
    pass:populated && absent,
    containment_id:containmentId,
    populated_before_supervisor_death:populated,
    absent_after_recovery:absent,
  };
}

try {
  fs.mkdirSync(`${workspace}/nested`,{recursive:true});

  const parity=[
    await parityCase('ascii-success',processSpec('/bin/sh',['-c','printf alpha; printf beta >&2'])),
    await parityCase('binary-output',processSpec('/usr/bin/printf',['\\377\\376A'])),
    await parityCase('independent-truncation',processSpec('/bin/sh',['-c','printf abcdefghijk; printf 123456789 >&2'],{
      stdout_max_bytes:5,
      stderr_max_bytes:3,
    })),
    await parityCase('relative-cwd',processSpec('/bin/sh',['-c','pwd'],{cwd:'nested'})),
    await parityCase('explicit-environment',processSpec('/bin/sh',['-c','printf %s "$OVERCENTER_TEST"'],{
      env:{OVERCENTER_TEST:'explicit'},
    })),
    await parityCase('nonzero-exit',processSpec('/bin/sh',['-c','exit 7'])),
    await parityCase('timeout',processSpec('/bin/sh',['-c','while :; do :; done'],{timeout_ms:50})),
    await parityCase('background-descendant',processSpec(descendantBinary,[])),
  ];

  const benchmark=async(executor:{execute:(item:ComputationExecution)=>Promise<unknown>},seconds:string)=>{
    const item=execution(processSpec('/usr/bin/sleep',[seconds],{timeout_ms:5000}));
    await executor.execute(item);
  };
  const noop=async(executor:{execute:(item:ComputationExecution)=>Promise<unknown>})=>{
    const item=execution(processSpec('/bin/true',[]));
    await executor.execute(item);
  };

  const recovery=await proveCatastrophicRecovery();

  const goNoop=await median(15,()=>noop(go));
  const rustNoop=await median(15,()=>noop(rust));
  const go100=await median(15,()=>benchmark(go,'0.1'));
  const rust100=await median(15,()=>benchmark(rust,'0.1'));
  const go1000=await median(5,()=>benchmark(go,'1'));
  const rust1000=await median(5,()=>benchmark(rust,'1'));

  const ratio=(candidate:number,control:number)=>candidate/control;
  const nonblank=(file:string):number=>
    fs.readFileSync(file,'utf8').split('\n').filter(line=>line.trim()).length;
  const sourcePaths=[
    'src/execution/executor/capture.go',
    'src/execution/executor/cmd/overcenter-executor/main.go',
    'src/execution/executor/executor.go',
    'src/execution/executor/process_linux.go',
    'src/execution/executor/process_supervisor_linux.go',
    'src/execution/executor/protocol.go',
    'src/execution/go-client.ts',
  ];
  const deletableLines=sourcePaths.reduce((sum,file)=>sum+nonblank(file),0);
  const candidateAdapterLines=nonblank(
    'experiments/rust-executor-consolidation/rust-computation-executor.ts',
  );
  const supportingTreatmentPairs=[
    [
      'experiments/rust-executor-consolidation/confined-executor-treatment.ts',
      'src/execution/confined-executor.ts',
    ],
    [
      'experiments/rust-executor-consolidation/execution-manifest-treatment.ts',
      'src/execution/manifest.ts',
    ],
    [
      'experiments/rust-executor-consolidation/treatment/manifest.rs',
      'src/execution/confinement/manifest.rs',
    ],
    [
      'experiments/rust-executor-consolidation/treatment/sandbox.rs',
      'src/execution/confinement/sandbox.rs',
    ],
  ] as const;
  const supportingProductionDelta=supportingTreatmentPairs.reduce(
    (sum,[treatment,baseline])=>sum+nonblank(treatment)-nonblank(baseline),
    0,
  );
  const candidateProductionLines=candidateAdapterLines+supportingProductionDelta;

  const parityPass=parity.every(item=>item.pass);
  const performancePass=ratio(rust100,go100)<=1.25 && ratio(rust1000,go1000)<=1.10;
  const simplificationPass=deletableLines>candidateProductionLines;
  const recoveryPass=recovery.pass;

  const report={
    schema:'overcenter-rust-executor-consolidation-result-v1',
    parity,
    performance_ms:{
      go_noop_median:goNoop,
      rust_noop_median:rustNoop,
      noop_ratio:ratio(rustNoop,goNoop),
      go_100ms_median:go100,
      rust_100ms_median:rust100,
      workload_100ms_ratio:ratio(rust100,go100),
      go_1s_median:go1000,
      rust_1s_median:rust1000,
      workload_1s_ratio:ratio(rust1000,go1000),
    },
    recovery,
    source_surface:{
      modeled_deletable_nonblank_lines:deletableLines,
      candidate_adapter_nonblank_lines:candidateAdapterLines,
      supporting_production_delta_nonblank_lines:supportingProductionDelta,
      total_candidate_production_nonblank_lines:candidateProductionLines,
      modeled_net_deleted_nonblank_lines:deletableLines-candidateProductionLines,
    },
    gates:{
      parity:parityPass,
      performance:performancePass,
      simplification:simplificationPass,
      catastrophic_recovery:recoveryPass,
    },
    deletion_supported:parityPass && performancePass && simplificationPass && recoveryPass,
  };
  console.log(JSON.stringify(report,null,2));
} finally {
  await go.close();
}
