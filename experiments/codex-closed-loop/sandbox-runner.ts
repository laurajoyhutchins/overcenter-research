import {createHash} from 'node:crypto';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

import {OvercenterKernel} from '../../src/kernel.ts';

type Snapshot=Map<string,string>;
type Args={stage:string;seed:string;worker:string;evidence:string|null};

const sha256=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const posix=(value:string)=>value.split(sep).join('/');

function parseArgs(argv:string[]):Args {
  const values=new Map<string,string>();
  for (let index=0;index<argv.length;index+=2) {
    const key=argv[index];
    const value=argv[index+1];
    if (!key?.startsWith('--') || value===undefined) throw new Error('SANDBOX_ARGUMENT_INVALID');
    values.set(key.slice(2),value);
  }
  return {
    stage:values.get('stage')??'',
    seed:values.get('seed')??'',
    worker:values.get('worker')??'scripted-control',
    evidence:values.get('evidence')??null,
  };
}

function files(root:string):string[] {
  const out:string[]=[];
  const visit=(directory:string):void=>{
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      const stat=lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('SANDBOX_SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) out.push(path);
      else throw new Error('SANDBOX_SPECIAL_FILE_FORBIDDEN');
    }
  };
  visit(root);
  return out.sort();
}

function snapshot(root:string):Snapshot {
  return new Map(files(root).map(path=>[
    posix(relative(root,path)),
    sha256(readFileSync(path)),
  ]));
}

function digest(snapshotValue:Snapshot):string {
  const hash=createHash('sha256');
  for (const [path,value] of [...snapshotValue].sort(([a],[b])=>a.localeCompare(b))) {
    hash.update(path).update('\0').update(value).update('\0');
  }
  return hash.digest('hex');
}

function changes(before:Snapshot,after:Snapshot):string[] {
  const keys=[...new Set([...before.keys(),...after.keys()])].sort();
  return keys.filter(key=>before.get(key)!==after.get(key));
}

function sourceRevision(repoRoot:string):string {
  const supplied=process.env.OVERCENTER_SOURCE_REVISION;
  const revision=supplied??execFileSync('git',['rev-parse','HEAD'],{
    cwd:repoRoot,
    encoding:'utf8',
    stdio:['ignore','pipe','ignore'],
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('SANDBOX_SOURCE_REVISION_INVALID');
  return revision;
}

function minimalEnv(home:string,temporary:string,seed:string):NodeJS.ProcessEnv {
  return {
    PATH:process.env.PATH??'',
    HOME:home,
    TMPDIR:temporary,
    LANG:'C.UTF-8',
    OVERCENTER_SANDBOX_SEED:seed,
  };
}

const args=parseArgs(process.argv.slice(2));
if (args.stage!=='single-useful-obligation') throw new Error('SANDBOX_STAGE_UNSUPPORTED');
if (!args.seed) throw new Error('SANDBOX_SEED_REQUIRED');
if (!['scripted-control','noop-control'].includes(args.worker)) throw new Error('SANDBOX_WORKER_UNSUPPORTED');

const experimentDir=dirname(fileURLToPath(import.meta.url));
const repoRoot=resolve(experimentDir,'../..');
const fixtureRoot=join(experimentDir,'sandbox-fixture');
const profileBytes=readFileSync(join(experimentDir,'sandbox-profile.json'));
const objectiveBytes=readFileSync(join(fixtureRoot,'objective.json'));
const workerBytes=readFileSync(join(experimentDir,'sandbox-worker-control.mjs'));
const sourceRevisionValue=sourceRevision(repoRoot);
const sandboxRoot=mkdtempSync(join(tmpdir(),'overcenter-autonomy-'));
const workspace=join(sandboxRoot,'workspace');
const authorityDir=join(sandboxRoot,'authority');
const inputDir=join(sandboxRoot,'input');
const attestationDir=join(sandboxRoot,'attestation');
const workerHome=join(sandboxRoot,'worker-home');
const workerTemp=join(sandboxRoot,'worker-tmp');
const workerProgram=join(sandboxRoot,'worker.mjs');
const database=join(authorityDir,'authority.sqlite');
const assignmentPath=join(inputDir,'assignment.json');
const attestationPath=join(attestationDir,'verified.txt');
const attestation='sandbox-objective-verified\n';
const seedDigest=sha256(args.seed);
const obligationId=`autonomy-sandbox-${seedDigest.slice(0,16)}`;
const started=Date.now();

let kernel:OvercenterKernel|null=null;
let evidence:Record<string,unknown>|null=null;

try {
  for (const path of [authorityDir,inputDir,attestationDir,workerHome,workerTemp]) mkdirSync(path,{recursive:true});
  cpSync(fixtureRoot,workspace,{recursive:true});
  writeFileSync(workerProgram,workerBytes,{mode:0o500});

  const before=snapshot(workspace);
  const fixtureDigest=digest(before);
  const objective=JSON.parse(objectiveBytes.toString('utf8')) as Record<string,unknown>;
  const faultSchedule:string[]=[];

  kernel=new OvercenterKernel(database,{observationContext:{localFileRoot:attestationDir}});
  kernel.initialize();
  kernel.define({
    id:obligationId,
    packet:{
      schema:'overcenter-autonomy-sandbox-task/v1',
      stage:args.stage,
      seed:args.seed,
      source_revision:sourceRevisionValue,
      fixture_sha256:fixtureDigest,
      profile_sha256:sha256(profileBytes),
      objective_sha256:sha256(objectiveBytes),
      objective_id:objective.id,
      instruction:objective.description,
      fault_schedule:faultSchedule,
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:attestationPath,
      content:attestation,
    },
  });

  const ready=kernel.deriveReadyWork();
  if (!ready || ready.id!==obligationId) throw new Error('SANDBOX_READY_WORK_MISSING');
  kernel.claim(ready.id,ready.revision);
  const claimed=kernel.inspect().find(work=>work.id===obligationId);
  if (!claimed?.run_id || !claimed.claimed_revision || claimed.status!=='EXECUTING') {
    throw new Error('SANDBOX_CLAIM_FAILED');
  }
  const permit=kernel.acquireExecution(claimed.run_id);
  const current=kernel.inspect().find(work=>work.id===obligationId);
  if (!current) throw new Error('SANDBOX_WORK_MISSING_AFTER_AUTHORITY_ACQUIRE');

  const assignment={
    schema:'overcenter-autonomy-sandbox-assignment/v1',
    stage:args.stage,
    seed:args.seed,
    source_revision:sourceRevisionValue,
    fixture_sha256:fixtureDigest,
    profile_sha256:sha256(profileBytes),
    objective_sha256:sha256(objectiveBytes),
    objective_id:objective.id,
    instruction:objective.description,
    work:{
      id:current.id,
      run_id:current.run_id,
      claimed_revision:current.claimed_revision,
      execution_generation:current.execution_generation,
    },
  };
  const assignmentBytes=Buffer.from(`${JSON.stringify(assignment,null,2)}\n`);
  writeFileSync(assignmentPath,assignmentBytes,{mode:0o400});
  chmodSync(assignmentPath,0o400);

  const workerStarted=Date.now();
  const workerResult=spawnSync(process.execPath,[workerProgram,assignmentPath,workspace,args.worker],{
    cwd:workspace,
    env:minimalEnv(workerHome,workerTemp,args.seed),
    encoding:'utf8',
    timeout:30_000,
  });
  const workerDurationMs=Math.max(1,Date.now()-workerStarted);

  const after=snapshot(workspace);
  const changedPaths=changes(before,after);
  const outsideScope=changedPaths.filter(path=>!path.startsWith('src/'));
  const verifier=spawnSync(process.execPath,['--experimental-strip-types','verify.mjs'],{
    cwd:workspace,
    env:minimalEnv(workerHome,workerTemp,args.seed),
    encoding:'utf8',
    timeout:30_000,
  });

  const accepted=workerResult.status===0 && outsideScope.length===0 && verifier.status===0;
  if (accepted) writeFileSync(attestationPath,attestation,{flag:'wx'});

  const receipt=kernel.resolve(permit,{
    sandbox_stage:args.stage,
    seed_sha256:seedDigest,
    worker_kind:args.worker,
    worker_program_sha256:sha256(workerBytes),
    assignment_sha256:sha256(assignmentBytes),
    candidate_tree_sha256:digest(after),
    changed_paths:changedPaths,
    worker_exit_code:workerResult.status,
    verifier_exit_code:verifier.status,
  });
  const falseDone=!accepted && receipt.disposition==='DONE' ? 1 : 0;
  if (falseDone) throw new Error('SANDBOX_FALSE_DONE');

  const expectedDisposition=accepted?'DONE':'READY';
  if (receipt.disposition!==expectedDisposition) {
    throw new Error(`SANDBOX_UNEXPECTED_DISPOSITION:${receipt.disposition}`);
  }

  const runId=claimed.run_id;
  const claimedRevision=claimed.claimed_revision;
  const generation=permit.execution_generation;
  const settlementCommit=receipt.settlement_commit??null;
  const unresolvedEffect=kernel.hasUnresolvedEffect(runId);
  kernel.close();
  kernel=null;

  const fresh=new OvercenterKernel(database,{observationContext:{localFileRoot:attestationDir}});
  const reconstructed=fresh.inspect().find(work=>work.id===obligationId);
  const reconstructionPassed=reconstructed?.status===expectedDisposition;
  fresh.close();
  if (!reconstructionPassed) throw new Error('SANDBOX_RECONSTRUCTION_FAILED');

  const useful=accepted && receipt.disposition==='DONE' ? 1 : 0;
  evidence={
    schema:'overcenter-autonomy-sandbox-evidence/v1',
    outcome:accepted?'accepted':'rejected',
    capability_claim:args.worker==='scripted-control'?'harness-only':'negative-control',
    stage:args.stage,
    seed:args.seed,
    source_revision:sourceRevisionValue,
    profile_sha256:sha256(profileBytes),
    fixture_sha256_before:fixtureDigest,
    fixture_sha256_after:digest(after),
    objective_sha256:sha256(objectiveBytes),
    assignment_sha256:sha256(assignmentBytes),
    fault_schedule:faultSchedule,
    worker:{
      kind:args.worker,
      program_sha256:sha256(workerBytes),
      exit_code:workerResult.status,
      stdout_sha256:sha256(workerResult.stdout??''),
      stderr_sha256:sha256(workerResult.stderr??''),
      credential_environment:'allowlist-only',
      physical_confinement_proven:false,
    },
    authority:{
      obligation_id:obligationId,
      run_id:runId,
      claimed_revision:claimedRevision,
      execution_generation:generation,
      settlement_commit:settlementCommit,
      disposition:receipt.disposition,
      verified:receipt.verified,
      unresolved_effect_after_settlement:unresolvedEffect,
      fresh_reconstruction_passed:reconstructionPassed,
    },
    candidate:{
      changed_paths:changedPaths,
      changes_outside_declared_project_scope:outsideScope,
      tree_sha256:digest(after),
      verifier_exit_code:verifier.status,
      verifier_stdout_sha256:sha256(verifier.stdout??''),
      verifier_stderr_sha256:sha256(verifier.stderr??''),
    },
    metrics:{
      verified_useful_transitions:useful,
      human_judgment_interventions:0,
      attempts:1,
      attempts_per_accepted_transition:useful?1:null,
      automatic_recoveries:0,
      false_done_count:falseDone,
      unsafe_or_duplicate_provider_effects:0,
      objective_completion_fraction:useful,
      worker_active_ms:workerDurationMs,
      useful_settlements_per_worker_hour:useful*(3_600_000/workerDurationMs),
      observed_project_changes_outside_scope:outsideScope.length,
      hidden_human_state_repairs:0,
    },
    promotion_evidence:{
      eligible:false,
      reasons:[
        'scripted control is not uncertain-agent evidence',
        'physical hostile-worker confinement is not established by this control',
        'fault-recovery stages have not been exercised',
      ],
    },
    elapsed_ms:Date.now()-started,
  };

  if (args.evidence) {
    const target=resolve(args.evidence);
    mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,`${JSON.stringify(evidence,null,2)}\n`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  if (kernel) kernel.close();
  rmSync(sandboxRoot,{recursive:true,force:true});
}
