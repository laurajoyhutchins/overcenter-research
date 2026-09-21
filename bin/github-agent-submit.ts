import {execFileSync} from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname} from 'node:path';

import {
  AGENT_RESPONSE_SCHEMA,
  assignmentFile,
  buildAssignment,
  encodeAssignment,
  validateCandidate,
} from '../src/assignment-capsule.mjs';
import {POSTCONDITION_VERIFIERS} from '../src/generated/schema-identifiers.ts';
import {GitOvercenterKernel} from '../src/git-kernel.ts';

const DEFAULT_AUTHORITY_REF='refs/overcenter/agent-ingress';
const TASK_PATH='experiments/assignment-capsule/fixture-task.mjs';
const INPUT_PATH='experiments/assignment-capsule/fixture-input.txt';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

function gitBytes(commit:string,path:string):Buffer {
  return execFileSync(
    'git',
    ['-C',process.cwd(),'show',`${commit}:${path}`],
    {maxBuffer:16*1024*1024},
  );
}

function record(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

const receiptPath=option('--receipt');
if (!receiptPath) {
  throw new Error('usage: github-agent-submit.ts --receipt <path>');
}

const requestId=required('REQUEST_ID').toLowerCase();
if (!/^[0-9a-f]{40}$/.test(requestId)) throw new Error('REQUEST_ID_INVALID');
const targetRequestSha=required('TARGET_REQUEST_SHA').toLowerCase();
if (!/^[0-9a-f]{40}$/.test(targetRequestSha)) {
  throw new Error('TARGET_REQUEST_SHA_INVALID');
}
const candidateSha=required('CANDIDATE_SHA').toLowerCase();
if (!/^[0-9a-f]{40,64}$/.test(candidateSha)) throw new Error('CANDIDATE_SHA_INVALID');

const authorityRef=process.env.OVERCENTER_INGRESS_AUTHORITY_REF??DEFAULT_AUTHORITY_REF;
const remote=process.env.OVERCENTER_INGRESS_REMOTE??'origin';
const obligationId=`github-agent-ingress-${targetRequestSha}`;
const candidatePath='.overcenter/candidate.json';

const kernel=new GitOvercenterKernel(process.cwd(),{remote,ref:authorityRef});
kernel.initialize();
const current=kernel.inspect().find(candidate=>candidate.id===obligationId);
if (!current) throw new Error('SUBMIT_OBLIGATION_MISSING');
if (!current.run_id) throw new Error('SUBMIT_RUN_ID_MISSING');

const assigned=kernel.claimedWork(current.run_id);
const sourceSha=String(assigned.packet.source_sha??'').toLowerCase();
if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) throw new Error('SUBMIT_SOURCE_SHA_INVALID');

const assignment=buildAssignment(assigned,[
  assignmentFile('task.mjs',gitBytes(sourceSha,TASK_PATH)),
  assignmentFile('input.txt',gitBytes(sourceSha,INPUT_PATH)),
]);
const assignmentBytes=encodeAssignment(assignment);
const candidate=validateCandidate(
  JSON.parse(gitBytes(candidateSha,candidatePath).toString('utf8')),
  assignment,
  assignmentBytes,
);

const priorDone=kernel.receipts(candidate.run_id)
  .filter(receipt=>receipt.disposition==='DONE' && receipt.verified)
  .at(-1);

if (priorDone) {
  const diagnostic=record(priorDone.diagnostic)
    && record(priorDone.diagnostic.assignment_candidate)
    ? priorDone.diagnostic.assignment_candidate
    : null;
  if (
    !diagnostic
    || diagnostic.assignment_sha256!==candidate.assignment_sha256
    || diagnostic.output_sha256!==candidate.output_sha256
  ) {
    throw new Error('CANDIDATE_DOES_NOT_MATCH_SETTLED_OUTPUT');
  }

  const receipt={
    schema:AGENT_RESPONSE_SCHEMA,
    operation:'submit',
    request_sha:requestId,
    target_request_sha:targetRequestSha,
    candidate_sha:candidateSha,
    authority_ref:authorityRef,
    authority_head:kernel.head(),
    obligation_id:assigned.id,
    run_id:candidate.run_id,
    claimed_revision:candidate.claimed_revision,
    assignment_sha256:candidate.assignment_sha256,
    output_sha256:candidate.output_sha256,
    disposition:'DONE',
    verified:true,
    settlement_commit:priorDone.settlement_commit??null,
    already_settled:true,
  };
  writeFileSync(receiptPath,`${JSON.stringify(receipt,null,2)}\n`);
  console.log(JSON.stringify(receipt));
  process.exit(0);
}

if (!['EXECUTING','RECOVERY_REQUIRED'].includes(current.status)) {
  throw new Error(`SUBMIT_RUN_NOT_SETTLEABLE:${current.status}`);
}
const postcondition=assigned.postcondition;
if (
  postcondition.verifier!==POSTCONDITION_VERIFIERS.fileContentEquals
  || typeof postcondition.path!=='string'
  || typeof postcondition.content!=='string'
) {
  throw new Error('SUBMIT_POSTCONDITION_UNSUPPORTED');
}

const output=Buffer.from(candidate.output_base64,'base64');
const root=dirname(postcondition.path);
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});
writeFileSync(postcondition.path,output,{flag:'wx'});

const settlementKernel=new GitOvercenterKernel(process.cwd(),{
  remote,
  ref:authorityRef,
  observationContext:{localFileRoot:root},
});
const before=settlementKernel.inspect().find(work=>work.id===obligationId);
if (!before || !before.run_id || before.run_id!==candidate.run_id) {
  throw new Error('SUBMIT_AUTHORITY_RUN_MISMATCH');
}
if (!['EXECUTING','RECOVERY_REQUIRED'].includes(before.status)) {
  throw new Error(`SUBMIT_AUTHORITY_NOT_SETTLEABLE:${before.status}`);
}

const permit=settlementKernel.acquireExecution(candidate.run_id);
const settled=settlementKernel.resolve(permit,{
  assignment_candidate:{
    assignment_sha256:candidate.assignment_sha256,
    output_sha256:candidate.output_sha256,
    candidate_sha:candidateSha,
  },
});
if (settled.disposition!=='DONE' || settled.verified!==true) {
  throw new Error(`SUBMIT_CANDIDATE_NOT_VERIFIED:${settled.disposition}`);
}

const receipt={
  schema:AGENT_RESPONSE_SCHEMA,
  operation:'submit',
  request_sha:requestId,
  target_request_sha:targetRequestSha,
  candidate_sha:candidateSha,
  authority_ref:authorityRef,
  authority_head:settlementKernel.head(),
  obligation_id:assigned.id,
  run_id:candidate.run_id,
  claimed_revision:candidate.claimed_revision,
  assignment_sha256:candidate.assignment_sha256,
  output_sha256:candidate.output_sha256,
  disposition:settled.disposition,
  verified:settled.verified,
  settlement_commit:settled.settlement_commit??null,
  already_settled:false,
};
writeFileSync(receiptPath,`${JSON.stringify(receipt,null,2)}\n`);
console.log(JSON.stringify(receipt));
