import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PROCESS_SPEC_SCHEMA,
  assertComputationEvidenceFor,
  type ComputationExecutionV1,
  type ProcessSpecV1,
} from '../src/execution/protocol.ts';
import {
  TEST_COMPUTATION_PACKET_SCHEMA,
  runReadyTestComputation,
  type ComputationExecutor,
} from '../src/execution/runner.ts';
import {OvercenterKernel} from '../src/authority/kernel.ts';
import {GoExecutorClient} from '../src/execution/go-client.ts';
import {
  PRODUCTION_COMPUTATION_CONTAINMENT,
  productionDockerIsolationArgs,
  productionExecutorArgs,
} from '../src/execution/containment.ts';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const image=process.env.OVERCENTER_SELF_APPLICATION_IMAGE;
if (!image) throw new Error('OVERCENTER_SELF_APPLICATION_IMAGE is required');

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const sourceSha=option('--source-sha')?.toLowerCase();
if (!sourceSha || !/^[0-9a-f]{40,64}$/.test(sourceSha)) {
  throw new Error('--source-sha must be an exact Git object id');
}
const reportPath=option('--report');

const checkedOutSha=execFileSync(
  'git',
  ['-C',repoRoot,'rev-parse','HEAD'],
  {encoding:'utf8'},
).trim().toLowerCase();
if (checkedOutSha!==sourceSha) {
  throw new Error(
    `SELF_APPLICATION_CHECKOUT_REVISION_MISMATCH:expected=${sourceSha}:actual=${checkedOutSha}`,
  );
}

const scratch=mkdtempSync(join(tmpdir(),'overcenter-self-application-'));
const workspace=join(scratch,'workspace');
const attestations=join(scratch,'authority-attestations');
const control=join(scratch,'control');
const stateDatabase=join(scratch,'state.sqlite');
const sourceRoot=join(scratch,'source');
mkdirSync(sourceRoot,{recursive:true});
const sourceArchive=execFileSync(
  'git',
  ['-C',repoRoot,'archive','--format=tar',sourceSha],
  {maxBuffer:64*1024*1024},
);
const sourceExtract=spawnSync(
  'tar',
  ['-xf','-','-C',sourceRoot],
  {input:sourceArchive},
);
if (sourceExtract.status!==0) {
  throw new Error(
    `SELF_APPLICATION_SOURCE_SNAPSHOT_EXTRACTION_FAILED:${sourceExtract.stderr?.toString('utf8')??''}`,
  );
}
if (existsSync(join(sourceRoot,'.git'))) {
  throw new Error('SELF_APPLICATION_SOURCE_SNAPSHOT_CONTAINS_GIT_METADATA');
}
mkdirSync(workspace,{recursive:true});
chmodSync(workspace,0o777);
mkdirSync(attestations,{recursive:true});
mkdirSync(control,{recursive:true});
chmodSync(control,0o750);

let sequence=0;
const label=`overcenter.self-application=${process.pid}`;
const npmCli='/usr/local/lib/node_modules/npm/bin/npm-cli.js';

function docker(args:string[]):string {
  return execFileSync('docker',args,{encoding:'utf8'});
}

function executionContextSha256():string {
  const imageId=docker(['image','inspect',image!,'--format','{{.Id}}']).trim();
  const bytes=JSON.stringify({
    schema:'overcenter-self-application-execution-context-v1',
    image_id:imageId,
    source_sha:sourceSha,
    containment:PRODUCTION_COMPUTATION_CONTAINMENT,
  });
  return 'sha256:'+createHash('sha256').update(bytes).digest('hex');
}

function processSpec(
  tier:'regression'|'experiments',
):ProcessSpecV1 {
  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable:'/usr/local/bin/node',
    argv:tier==='regression'
      ? [npmCli,'test']
      : [npmCli,'run','test:experiments'],
    cwd:'source',
    env:{
      HOME:'/tmp',
      NPM_CONFIG_CACHE:'/tmp/npm-cache',
      OVERCENTER_SOURCE_SHA:sourceSha,
      PATH:'/usr/local/bin:/usr/bin:/bin',
    },
    timeout_ms:tier==='regression' ? 180_000 : 600_000,
    stdout_max_bytes:512*1024,
    stderr_max_bytes:512*1024,
  };
}

interface ExecutorHarness {
  client:GoExecutorClient;
  diagnostics:()=>Record<string,unknown>;
  close:()=>Promise<void>;
  abort:()=>Promise<void>;
}

async function startExecutor():Promise<ExecutorHarness> {
  const id=sequence++;
  const socketPath=join(control,`executor-${id}.sock`);
  const container=`overcenter-self-application-${process.pid}-${id}`;
  const containmentId=`overcenter-self-application-${randomUUID()}`;
  const contextSha256=executionContextSha256();
  const gid=process.getgid?.();
  if (gid===undefined) throw new Error('host gid unavailable');

  docker([
    'run',
    '-d',
    '--name',container,
    '--label',label,
    '--label',`overcenter.containment=${containmentId}`,
    ...productionDockerIsolationArgs(),
    '--entrypoint','/usr/local/bin/overcenter-executor',
    '-v',`${control}:/control`,
    '-v',`${workspace}:/workspace`,
    '-v',`${sourceRoot}:/workspace/source:ro`,
    image,
    ...productionExecutorArgs({
      socketPath:`/control/executor-${id}.sock`,
      workspaceRoot:'/workspace',
      socketGid:gid,
      executionContextSha256:contextSha256,
      containmentId,
    }),
  ]);

  const deadline=Date.now()+10_000;
  while (!existsSync(socketPath) && Date.now()<deadline) {
    const running=docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      container,
    ]).trim();
    if (running!=='true') {
      throw new Error(`self-application executor exited early: ${docker(['logs',container])}`);
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  if (!existsSync(socketPath)) throw new Error('self-application executor socket never appeared');

  const client=new GoExecutorClient({
    socketPath,
    maxConcurrency:1,
    executionContextSha256:contextSha256,
    containmentId,
  });
  await client.ready();
  const remove=():void=>{
    try {
      execFileSync('docker',['rm',container],{stdio:'ignore'});
    } catch {
      // Final label cleanup is the backstop.
    }
  };

  return {
    client,
    diagnostics:()=>{
      let state:unknown=null;
      let cgroup='';
      try {
        state=JSON.parse(docker(['inspect','--format','{{json .State}}',container]));
      } catch {}
      try {
        cgroup=docker([
          'exec',container,'sh','-c',
          'printf "pids.events\\n"; cat /sys/fs/cgroup/pids.events 2>/dev/null || true; printf "memory.events\\n"; cat /sys/fs/cgroup/memory.events 2>/dev/null || true',
        ]);
      } catch {}
      return {state,cgroup};
    },
    close:async()=>{
      await client.close();
      const code=Number.parseInt(docker(['wait',container]).trim(),10);
      assert.equal(code,0,docker(['logs',container]));
      remove();
    },
    abort:async()=>{
      try {
        execFileSync('docker',['kill',container],{stdio:'ignore'});
      } catch {
        // The container may already have failed.
      }
      try {
        docker(['wait',container]);
      } catch {
        // Removal below is authoritative cleanup.
      }
      remove();
    },
  };
}

function attestingExecutor(
  client:GoExecutorClient,
  marker:string,
  content:string,
):ComputationExecutor {
  return {
    get executionContextSha256(){ return client.executionContextSha256; },
    get containmentId(){ return client.containmentId; },
    ready:()=>client.ready(),
    execute:async(execution:ComputationExecutionV1)=>{
      const evidence=await client.execute(execution);
      assertComputationEvidenceFor(evidence,execution);
      if (evidence.outcome==='completed' && evidence.exit_code===0) {
        // This path is intentionally outside every task/container mount. The
        // task cannot manufacture the postcondition that settles itself.
        writeFileSync(marker,content);
      }
      return evidence;
    },
  };
}

function assertNoEffectReservations():void {
  const db=new DatabaseSync(stateDatabase);
  try {
    const row=db.prepare(`
      SELECT COUNT(*) AS count
      FROM fact_commits
      WHERE files_json LIKE '%"effect-reservation.json"%'
    `).get() as {count:number|bigint};
    if (Number(row.count)!==0) {
      throw new Error(
        `pure self-application computation reserved ${String(row.count)} external effects`,
      );
    }
  } finally {
    db.close();
  }
}

function summarize(kernel:OvercenterKernel) {
  return kernel.inspect().map(work=>({
    id:work.id,
    status:work.status,
    revision:work.revision,
    ...(work.run_id?{run_id:work.run_id}:{}),
    ...(work.execution_generation===undefined
      ? {}
      : {execution_generation:work.execution_generation}),
  }));
}

const regressionMarker=join(attestations,'regression.passed');
const regressionContent=`passed:regression:${sourceSha}\n`;
const experimentsMarker=join(attestations,'experiments.passed');
const experimentsContent=`passed:experiments:${sourceSha}\n`;

const kernel=new OvercenterKernel(stateDatabase);
kernel.initialize();
kernel.define({
  id:'self-regression',
  packet:{
    schema:TEST_COMPUTATION_PACKET_SCHEMA,
    kind:'test',
    process_spec:processSpec('regression'),
  },
  postcondition:{
    verifier:'file-content-equals/v1',
    path:regressionMarker,
    content:regressionContent,
  },
});
kernel.define({
  id:'self-experiments',
  dependencies:[{kind:'control',upstream:'self-regression'}],
  packet:{
    schema:TEST_COMPUTATION_PACKET_SCHEMA,
    kind:'test',
    process_spec:processSpec('experiments'),
  },
  postcondition:{
    verifier:'file-content-equals/v1',
    path:experimentsMarker,
    content:experimentsContent,
  },
});

let executor:ExecutorHarness|null=null;
try {
  executor=await startExecutor();
  const attempted=new Set<string>();

  while (true) {
    const projection=kernel.inspect();
    if (projection.every(work=>work.status==='DONE')) break;

    const ready=projection.find(work=>work.status==='READY');
    if (!ready) {
      const details=projection.map(work=>({
        id:work.id,
        status:work.status,
        explanation:kernel.explain(work.id),
      }));
      throw new Error(`self-application stalled: ${JSON.stringify(details)}`);
    }
    if (attempted.has(ready.id)) {
      throw new Error(
        `self-application task remained READY after one exact attempt: ${JSON.stringify(kernel.explain(ready.id))}`,
      );
    }
    attempted.add(ready.id);

    const [marker,content]=ready.id==='self-regression'
      ? [regressionMarker,regressionContent]
      : ready.id==='self-experiments'
        ? [experimentsMarker,experimentsContent]
        : (()=>{throw new Error(`unexpected self-application obligation: ${ready.id}`);})();

    const result=await runReadyTestComputation(
      kernel,
      attestingExecutor(executor.client,marker,content),
    );
    if (!result || result.work_id!==ready.id) {
      throw new Error('self-application scheduler/executor disagreement');
    }

    process.stdout.write(JSON.stringify({
      event:'self-application-attempt',
      source_sha:sourceSha,
      work_id:result.work_id,
      state:result.state,
      run_id:result.run_id,
      execution_generation:result.execution_generation,
      execution_spec_sha256:result.execution_spec_sha256,
      attempt_outcome:result.evidence?.outcome??'transport-failure',
      exit_code:result.evidence?.exit_code??null,
      settlement_commit:result.receipt.settlement_commit??null,
    })+'\n');

    if (result.state!=='DONE') {
      const decode=(value:string|undefined):string=>
        value ? Buffer.from(value,'base64').toString('utf8') : '';
      const stdout=decode(result.evidence?.stdout_base64);
      const stderr=decode(result.evidence?.stderr_base64);
      const failureLines=stdout.split('\n');
      const failureIndexes=failureLines
        .map((line,index)=>line.startsWith('not ok ')?index:-1)
        .filter(index=>index>=0);
      const failureExcerpts=failureIndexes.map(index=>
        failureLines.slice(Math.max(0,index-2),Math.min(failureLines.length,index+24)).join('\n'),
      );
      process.stderr.write(JSON.stringify({
        event:'self-application-attempt-diagnostics',
        work_id:result.work_id,
        outcome:result.evidence?.outcome??'transport-failure',
        failure_excerpts:failureExcerpts,
        stdout_tail:stdout.slice(-8*1024),
        stderr_tail:stderr.slice(-8*1024),
        stdout_truncated:result.evidence?.stdout_truncated??false,
        stderr_truncated:result.evidence?.stderr_truncated??false,
        containment:executor.diagnostics(),
      })+'\n');
      throw new Error(
        `self-application evidence did not settle DONE: ${JSON.stringify(kernel.explain(ready.id))}`,
      );
    }
  }

  assertNoEffectReservations();
  const authorityHead=kernel.head();
  assert.ok(authorityHead);

  await executor.close();
  executor=null;

  kernel.close();
  const reconstructed=new OvercenterKernel(stateDatabase);
  assert.equal(reconstructed.head(),authorityHead);
  const reconstructedWork=summarize(reconstructed);
  assert.ok(reconstructedWork.every(work=>work.status==='DONE'));
  assertNoEffectReservations();

  const receipts=reconstructed.receipts().map(receipt=>({
    obligation_id:receipt.obligation_id,
    disposition:receipt.disposition,
    verified:receipt.verified,
    run_id:receipt.run_id,
    execution_generation:receipt.execution_generation,
    settlement_commit:receipt.settlement_commit??null,
  }));
  assert.equal(receipts.length,2);
  assert.ok(receipts.every(receipt=>receipt.disposition==='DONE' && receipt.verified));

  const report={
    schema:'overcenter-self-application-v1',
    source_sha:sourceSha,
    authority_head:authorityHead,
    work:reconstructedWork,
    receipts,
    reconstructed:true,
    source_mounted_read_only:true,
    source_snapshot_excludes_git_metadata:true,
    containment_profile:PRODUCTION_COMPUTATION_CONTAINMENT,
    authority_attestations_outside_task_workspace:true,
    external_effect_reservations:0,
  };
  const serialized=JSON.stringify(report,null,2)+'\n';
  process.stdout.write(serialized);
  if (reportPath) writeFileSync(reportPath,serialized);
  reconstructed.close();
} finally {
  try {
    kernel.close();
  } catch {
    // The successful reconstruction path already closed the original handle.
  }
  if (executor) await executor.abort();
  try {
    const ids=docker(['ps','-aq','--filter',`label=${label}`])
      .trim().split(/\s+/).filter(Boolean);
    if (ids.length>0) execFileSync('docker',['rm','-f',...ids],{stdio:'ignore'});
  } catch {
    // Best-effort cleanup after the authoritative result has already failed.
  }
  rmSync(scratch,{recursive:true,force:true});
}
