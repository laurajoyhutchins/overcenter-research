import {createHash} from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';

import {runConfinedWorker} from '../../src/confined-executor.ts';
import {OvercenterKernel} from '../../src/kernel.ts';

type Snapshot=Map<string,string>;
type Args={
  stage:string;
  seed:string;
  worker:string;
  evidence:string|null;
  candidate:string|null;
  provenance:string|null;
  launcher:string|null;
};
type Candidate={
  schema:'overcenter-autonomy-sandbox-candidate/v1';
  writes:Array<{path:string;content:string}>;
  deletes:string[];
};
type Provenance={
  schema:'overcenter-autonomy-model-candidate-provenance/v1';
  provider:string;
  transport:string;
  repository_mutation_observed:boolean;
  prompt_sha256:string;
  candidate_sha256:string;
  response_body_sha256:string;
  request_comment_id?:number;
  response_comment_id?:number;
  response_author?:string;
  branch_head_before_request?:string;
  branch_head_after_response?:string;
  model_id?:string;
  model_revision?:string;
  model_sha256?:string;
  runtime_id?:string;
  runtime_sha256?:string;
  network_during_inference?:boolean;
  repository_credentials_present?:boolean;
  checkout_readable_during_inference?:boolean;
  worker_uid_isolated?:boolean;
  input_scope?:string;
  worker_job_is_disposable?:boolean;
};
type VerifierResult={
  status:number|null;
  stdout:string;
  stderr:string;
  completion_proven:boolean;
  confined:boolean;
  manifest_sha256:string|null;
};

const sha256=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const posix=(value:string)=>value.split(sep).join('/');
const ALLOWED_WRITES=['src/format.ts','src/index.ts','src/math.ts'];
const ALLOWED_DELETES=['src/format.js','src/index.js','src/math.js'];

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
    candidate:values.get('candidate')??null,
    provenance:values.get('provenance')??null,
    launcher:values.get('launcher')??null,
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

function exactSet(name:string,actual:string[],expected:string[]):void {
  const normalized=[...actual].sort();
  const target=[...expected].sort();
  if (normalized.length!==target.length || normalized.some((value,index)=>value!==target[index])) {
    throw new Error(`${name}_MISMATCH`);
  }
}

function loadCandidate(path:string):{candidate:Candidate;bytes:Buffer} {
  const bytes=readFileSync(path);
  let value:unknown;
  try { value=JSON.parse(bytes.toString('utf8')); } catch { throw new Error('SANDBOX_CANDIDATE_JSON_INVALID'); }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('SANDBOX_CANDIDATE_INVALID');
  const candidate=value as Partial<Candidate>;
  if (candidate.schema!=='overcenter-autonomy-sandbox-candidate/v1') throw new Error('SANDBOX_CANDIDATE_SCHEMA_MISMATCH');
  if (!Array.isArray(candidate.writes) || !Array.isArray(candidate.deletes)) throw new Error('SANDBOX_CANDIDATE_SHAPE_INVALID');
  const writePaths:string[]=[];
  const seen=new Set<string>();
  for (const write of candidate.writes) {
    if (!write || typeof write!=='object' || typeof write.path!=='string' || typeof write.content!=='string') {
      throw new Error('SANDBOX_CANDIDATE_WRITE_INVALID');
    }
    if (seen.has(write.path)) throw new Error('SANDBOX_CANDIDATE_WRITE_DUPLICATE');
    seen.add(write.path);
    if (write.content.includes('\0') || Buffer.byteLength(write.content,'utf8')>16_384) {
      throw new Error('SANDBOX_CANDIDATE_CONTENT_INVALID');
    }
    writePaths.push(write.path);
  }
  if (candidate.deletes.some(value=>typeof value!=='string')) throw new Error('SANDBOX_CANDIDATE_DELETE_INVALID');
  if (new Set(candidate.deletes).size!==candidate.deletes.length) throw new Error('SANDBOX_CANDIDATE_DELETE_DUPLICATE');
  exactSet('SANDBOX_CANDIDATE_WRITES',writePaths,ALLOWED_WRITES);
  exactSet('SANDBOX_CANDIDATE_DELETES',candidate.deletes as string[],ALLOWED_DELETES);
  return {candidate:candidate as Candidate,bytes};
}

function loadProvenance(path:string,candidateBytes:Buffer):{provenance:Provenance;bytes:Buffer} {
  const bytes=readFileSync(path);
  let value:unknown;
  try { value=JSON.parse(bytes.toString('utf8')); } catch { throw new Error('SANDBOX_PROVENANCE_JSON_INVALID'); }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('SANDBOX_PROVENANCE_INVALID');
  const provenance=value as Partial<Provenance>;
  if (provenance.schema!=='overcenter-autonomy-model-candidate-provenance/v1') throw new Error('SANDBOX_PROVENANCE_SCHEMA_MISMATCH');
  if (provenance.candidate_sha256!==sha256(candidateBytes)) throw new Error('SANDBOX_PROVENANCE_CANDIDATE_DIGEST_MISMATCH');
  if (provenance.repository_mutation_observed!==false) throw new Error('SANDBOX_PROVENANCE_REPOSITORY_MUTATION');
  for (const key of ['provider','transport','prompt_sha256','response_body_sha256'] as const) {
    if (typeof provenance[key]!=='string' || !provenance[key]) throw new Error('SANDBOX_PROVENANCE_FIELD_INVALID');
  }

  if (provenance.transport==='github-pr-comment') {
    if (provenance.response_author!=='chatgpt-codex-connector[bot]') throw new Error('SANDBOX_PROVENANCE_AUTHOR_MISMATCH');
    if (
      typeof provenance.branch_head_before_request!=='string'
      || typeof provenance.branch_head_after_response!=='string'
      || provenance.branch_head_before_request!==provenance.branch_head_after_response
    ) throw new Error('SANDBOX_PROVENANCE_HEAD_CHANGED');
  } else if (provenance.transport==='offline-llama.cpp') {
    for (const key of ['model_id','model_revision','model_sha256','runtime_id','runtime_sha256'] as const) {
      if (typeof provenance[key]!=='string' || !provenance[key]) throw new Error('SANDBOX_LOCAL_MODEL_PROVENANCE_INVALID');
    }
    if (!/^[0-9a-f]{64}$/.test(provenance.model_sha256!)) throw new Error('SANDBOX_MODEL_DIGEST_INVALID');
    if (!/^[0-9a-f]{64}$/.test(provenance.runtime_sha256!)) throw new Error('SANDBOX_RUNTIME_DIGEST_INVALID');
    if (provenance.network_during_inference!==false) throw new Error('SANDBOX_LOCAL_MODEL_NETWORK_NOT_DISABLED');
    if (provenance.repository_credentials_present!==false) throw new Error('SANDBOX_LOCAL_MODEL_REPOSITORY_CREDENTIAL_PRESENT');
    if (provenance.checkout_readable_during_inference!==false) throw new Error('SANDBOX_LOCAL_MODEL_CHECKOUT_READABLE');
    if (provenance.worker_uid_isolated!==true) throw new Error('SANDBOX_LOCAL_MODEL_UID_NOT_ISOLATED');
    if (provenance.input_scope!=='synthetic-prompt-and-schema-only') throw new Error('SANDBOX_LOCAL_MODEL_INPUT_SCOPE_INVALID');
    if (provenance.worker_job_is_disposable!==true) throw new Error('SANDBOX_LOCAL_MODEL_WORKER_NOT_DISPOSABLE');
  } else {
    throw new Error('SANDBOX_PROVENANCE_TRANSPORT_UNSUPPORTED');
  }
  return {provenance:provenance as Provenance,bytes};
}

function applyCandidate(workspace:string,candidate:Candidate):void {
  for (const write of candidate.writes) {
    const target=join(workspace,...write.path.split('/'));
    if (existsSync(target)) throw new Error('SANDBOX_CANDIDATE_WRITE_ALREADY_EXISTS');
    writeFileSync(target,write.content,{flag:'wx'});
  }
  for (const candidatePath of candidate.deletes) {
    const target=join(workspace,...candidatePath.split('/'));
    const stat=lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SANDBOX_CANDIDATE_DELETE_TARGET_INVALID');
    unlinkSync(target);
  }
}

function runtimeExecutableClosure(program:string):string[] {
  const output=execFileSync('ldd',[program],{encoding:'utf8'});
  const paths=[...output.matchAll(/(?:=>\s*)?(\/[^\s()]+)/gu)].map(match=>match[1]);
  return [...new Set(paths)].filter(path=>path!==program).sort();
}

function verifierCompletionProven(stdout:string):boolean {
  const lines=stdout.endsWith('\n')
    ? stdout.slice(0,-1).split('\n')
    : stdout.split('\n');
  if (lines.length!==2) return false;
  const challenge=/^OVERCENTER_VERIFY_CHALLENGE ([0-9a-f]{64})$/.exec(lines[0]??'');
  const completion=/^OVERCENTER_VERIFY_COMPLETE ([0-9a-f]{64})$/.exec(lines[1]??'');
  return challenge!==null && completion!==null && challenge[1]===completion[1];
}

function candidateModuleUrl(workspace:string):string {
  const sourceRoot=join(workspace,'src');
  const strip=(name:string)=>stripTypeScriptTypes(
    readFileSync(join(sourceRoot,name),'utf8'),
    {mode:'strip'},
  );
  const dataUrl=(source:string)=>`data:text/javascript;base64,${Buffer.from(source,'utf8').toString('base64')}`;

  const mathUrl=dataUrl(strip('math.ts'));
  const formatUrl=dataUrl(strip('format.ts'));
  let index=strip('index.ts');
  index=index
    .split("'./math.ts'").join(`'${mathUrl}'`)
    .split('"./math.ts"').join(`"${mathUrl}"`)
    .split("'./format.ts'").join(`'${formatUrl}'`)
    .split('"./format.ts"').join(`"${formatUrl}"`);
  return dataUrl(index);
}

async function runVerifier(
  workspace:string,
  home:string,
  temporary:string,
  seed:string,
  launcher:string|null,
):Promise<VerifierResult> {
  const moduleUrl=candidateModuleUrl(workspace);
  if (!launcher) {
    const result=spawnSync(process.execPath,['verify.cjs',moduleUrl],{
      cwd:workspace,
      env:minimalEnv(home,temporary,seed),
      encoding:'utf8',
      timeout:30_000,
    });
    const stdout=result.stdout??'';
    return {
      status:result.status,
      stdout,
      stderr:result.stderr??'',
      completion_proven:verifierCompletionProven(stdout),
      confined:false,
      manifest_sha256:null,
    };
  }

  const stat=statSync(workspace,{bigint:true});
  const result=await runConfinedWorker({
    launcher:resolve(launcher),
    manifest:{
      task_id:`autonomy-sandbox-verifier-${sha256(seed).slice(0,12)}`,
      workspace,
      workspace_dev:stat.dev.toString(),
      workspace_ino:stat.ino.toString(),
      program:process.execPath,
      timeout_ms:30_000,
      max_output_bytes:65_536,
      args:['verify.cjs',moduleUrl],
      environment:{LANG:'C.UTF-8'},
      runtime_read_only:existsSync('/etc/ld.so.cache')?['/etc/ld.so.cache']:[],
      runtime_executable:runtimeExecutableClosure(process.execPath),
    },
  });
  return {
    status:result.exit_code,
    stdout:result.stdout,
    stderr:result.stderr,
    completion_proven:verifierCompletionProven(result.stdout),
    confined:true,
    manifest_sha256:result.manifest_sha256,
  };
}

const args=parseArgs(process.argv.slice(2));
if (args.stage!=='single-useful-obligation') throw new Error('SANDBOX_STAGE_UNSUPPORTED');
if (!args.seed) throw new Error('SANDBOX_SEED_REQUIRED');
if (!['scripted-control','noop-control','recorded-model'].includes(args.worker)) throw new Error('SANDBOX_WORKER_UNSUPPORTED');
if (args.worker==='recorded-model' && (!args.candidate || !args.provenance)) throw new Error('SANDBOX_MODEL_INPUT_REQUIRED');
if (args.worker!=='recorded-model' && (args.candidate || args.provenance)) throw new Error('SANDBOX_MODEL_INPUT_UNEXPECTED');

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
  let workerStatus:number|null=0;
  let workerStdout='';
  let workerStderr='';
  let candidateSha256:string|null=null;
  let provenanceSha256:string|null=null;
  let provenance:Provenance|null=null;

  if (args.worker==='recorded-model') {
    const loadedCandidate=loadCandidate(resolve(args.candidate!));
    const loadedProvenance=loadProvenance(resolve(args.provenance!),loadedCandidate.bytes);
    applyCandidate(workspace,loadedCandidate.candidate);
    candidateSha256=sha256(loadedCandidate.bytes);
    provenanceSha256=sha256(loadedProvenance.bytes);
    provenance=loadedProvenance.provenance;
    workerStdout=JSON.stringify({candidate_sha256:candidateSha256});
  } else {
    const result=spawnSync(process.execPath,[workerProgram,assignmentPath,workspace,args.worker],{
      cwd:workspace,
      env:minimalEnv(workerHome,workerTemp,args.seed),
      encoding:'utf8',
      timeout:30_000,
    });
    workerStatus=result.status;
    workerStdout=result.stdout??'';
    workerStderr=result.stderr??'';
  }
  const workerDurationMs=Math.max(1,Date.now()-workerStarted);

  const after=snapshot(workspace);
  const changedPaths=changes(before,after);
  const outsideScope=changedPaths.filter(path=>!path.startsWith('src/'));
  const verifier=await runVerifier(workspace,workerHome,workerTemp,args.seed,args.launcher);

  const accepted=workerStatus===0
    && outsideScope.length===0
    && verifier.status===0
    && verifier.completion_proven;
  if (!accepted && verifier.stderr) {
    process.stderr.write(`SANDBOX_VERIFIER_STDERR:\n${verifier.stderr}`);
  }
  if (accepted) writeFileSync(attestationPath,attestation,{flag:'wx'});

  const receipt=kernel.resolve(permit,{
    sandbox_stage:args.stage,
    seed_sha256:seedDigest,
    worker_kind:args.worker,
    worker_program_sha256:args.worker==='recorded-model'?null:sha256(workerBytes),
    model_candidate_sha256:candidateSha256,
    model_provenance_sha256:provenanceSha256,
    assignment_sha256:sha256(assignmentBytes),
    candidate_tree_sha256:digest(after),
    changed_paths:changedPaths,
    worker_exit_code:workerStatus,
    verifier_exit_code:verifier.status,
    verifier_manifest_sha256:verifier.manifest_sha256,
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
  const modelWitness=args.worker==='recorded-model';
  const localReasoningConfined=provenance?.transport==='offline-llama.cpp'
    && provenance.network_during_inference===false
    && provenance.repository_credentials_present===false
    && provenance.checkout_readable_during_inference===false
    && provenance.worker_uid_isolated===true
    && provenance.input_scope==='synthetic-prompt-and-schema-only'
    && provenance.worker_job_is_disposable===true;
  const promotionReasons=modelWitness
    ? provenance?.transport==='offline-llama.cpp'
      ? [
        'only the Stage 1 single-obligation capability has been exercised',
        'fault-recovery stages have not been exercised',
      ]
      : [
        'uncertain reasoning succeeded, but the Codex Cloud provider-side repository capability is not proven absent',
        'the model invocation is recorded evidence rather than replayable solely from repository state',
        'fault-recovery stages have not been exercised',
      ]
    : [
      'scripted control is not uncertain-agent evidence',
      ...(verifier.confined?[]:['candidate execution confinement was not exercised by this run']),
      'fault-recovery stages have not been exercised',
    ];

  evidence={
    schema:'overcenter-autonomy-sandbox-evidence/v1',
    outcome:accepted?'accepted':'rejected',
    capability_claim:modelWitness?'uncertain-reasoning-stage1':args.worker==='scripted-control'?'harness-only':'negative-control',
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
      program_sha256:modelWitness?null:sha256(workerBytes),
      candidate_sha256:candidateSha256,
      provenance_sha256:provenanceSha256,
      reasoning_provider:provenance?.provider??null,
      reasoning_transport:provenance?.transport??null,
      response_comment_id:provenance?.response_comment_id??null,
      repository_mutation_observed:provenance?.repository_mutation_observed??null,
      model_id:provenance?.model_id??null,
      model_revision:provenance?.model_revision??null,
      model_sha256:provenance?.model_sha256??null,
      runtime_id:provenance?.runtime_id??null,
      runtime_sha256:provenance?.runtime_sha256??null,
      network_during_inference:provenance?.network_during_inference??null,
      repository_credentials_present:provenance?.repository_credentials_present??null,
      checkout_readable_during_inference:provenance?.checkout_readable_during_inference??null,
      worker_uid_isolated:provenance?.worker_uid_isolated??null,
      input_scope:provenance?.input_scope??null,
      worker_job_is_disposable:provenance?.worker_job_is_disposable??null,
      exit_code:workerStatus,
      stdout_sha256:sha256(workerStdout),
      stderr_sha256:sha256(workerStderr),
      reasoning_process_confinement_proven:localReasoningConfined,
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
      verifier_stdout_sha256:sha256(verifier.stdout),
      verifier_stderr_sha256:sha256(verifier.stderr),
      verifier_completion_proven:verifier.completion_proven,
      execution_confinement_proven:verifier.confined,
      execution_manifest_sha256:verifier.manifest_sha256,
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
      worker_active_ms:modelWitness?null:workerDurationMs,
      useful_settlements_per_worker_hour:modelWitness?null:useful*(3_600_000/workerDurationMs),
      observed_project_changes_outside_scope:outsideScope.length,
      hidden_human_state_repairs:0,
    },
    promotion_evidence:{
      eligible:false,
      reasons:promotionReasons,
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
