import {execFileSync} from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {
  AGENT_TASK_PACKET_SCHEMA,
  assignmentFile,
  assignmentSha256,
  buildAssignment,
  encodeAssignment,
} from '../src/assignment-capsule.mjs';
import {GitOvercenterKernel} from '../src/git-kernel.ts';

const DEFAULT_AUTHORITY_REF='refs/overcenter/agent-ingress';
const TASK_PATH='experiments/assignment-capsule/fixture-task.mjs';
const INPUT_PATH='experiments/assignment-capsule/fixture-input.txt';
const RUNNER_PATH='src/assignment-capsule.mjs';

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

function sourceBytes(sourceSha:string,path:string):Buffer {
  return execFileSync(
    'git',
    ['-C',process.cwd(),'show',`${sourceSha}:${path}`],
    {maxBuffer:16*1024*1024},
  );
}

const capsuleDir=option('--capsule-dir');
const receiptPath=option('--receipt');
if (!capsuleDir || !receiptPath) {
  throw new Error('usage: github-agent-ingress.ts --capsule-dir <dir> --receipt <path>');
}

const requestCommentId=required('REQUEST_COMMENT_ID');
if (!/^[1-9][0-9]*$/.test(requestCommentId)) throw new Error('REQUEST_COMMENT_ID_INVALID');
const requestedSourceSha=required('SOURCE_SHA').toLowerCase();
if (!/^[0-9a-f]{40,64}$/.test(requestedSourceSha)) throw new Error('SOURCE_SHA_INVALID');

const obligationId=`github-agent-ingress-${requestCommentId}`;
const authorityRef=process.env.OVERCENTER_INGRESS_AUTHORITY_REF??DEFAULT_AUTHORITY_REF;
const remote=process.env.OVERCENTER_INGRESS_REMOTE??'origin';
const kernel=new GitOvercenterKernel(process.cwd(),{
  remote,
  ref:authorityRef,
});
kernel.initialize();

let work=kernel.inspect().find(candidate=>candidate.id===obligationId);
if (!work) {
  const inputBytes=sourceBytes(requestedSourceSha,INPUT_PATH);
  const expectedOutput=`completed:${inputBytes.toString('utf8').trim()}\n`;
  kernel.define({
    id:obligationId,
    packet:{
      schema:AGENT_TASK_PACKET_SCHEMA,
      kind:'pure-candidate',
      source_sha:requestedSourceSha,
      command:['node','task.mjs','input.txt','result.txt'],
      required_paths:['task.mjs','input.txt'],
      output_path:'result.txt',
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:`/tmp/${obligationId}/result.txt`,
      content:expectedOutput,
    },
  });
  work=kernel.inspect().find(candidate=>candidate.id===obligationId);
}
if (!work) throw new Error('INGRESS_OBLIGATION_MISSING');

if (work.status==='READY') {
  kernel.claim(work.id,work.revision);
  work=kernel.inspect().find(candidate=>candidate.id===obligationId);
}
if (!work) throw new Error('INGRESS_OBLIGATION_MISSING_AFTER_CLAIM');
if (work.status!=='EXECUTING') {
  throw new Error(`INGRESS_REQUEST_NOT_ASSIGNABLE:${work.status}`);
}
if (!work.run_id || !work.claimed_revision) throw new Error('INGRESS_CLAIM_IDENTITY_MISSING');

const packet=work.packet as Record<string,unknown>;
if (packet.schema!==AGENT_TASK_PACKET_SCHEMA || packet.kind!=='pure-candidate') {
  throw new Error('INGRESS_PACKET_SCHEMA_MISMATCH');
}
const sourceSha=String(packet.source_sha??'').toLowerCase();
if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) throw new Error('INGRESS_PACKET_SOURCE_INVALID');

const assignment=buildAssignment(work,[
  assignmentFile('task.mjs',sourceBytes(sourceSha,TASK_PATH)),
  assignmentFile('input.txt',sourceBytes(sourceSha,INPUT_PATH)),
]);
const assignmentBytes=encodeAssignment(assignment);
if (assignmentBytes.includes(Buffer.from('execution_capability'))) {
  throw new Error('INGRESS_ASSIGNMENT_LEAKED_EXECUTION_CAPABILITY');
}

rmSync(capsuleDir,{recursive:true,force:true});
mkdirSync(capsuleDir,{recursive:true});
writeFileSync(join(capsuleDir,'assignment.json'),assignmentBytes);
writeFileSync(join(capsuleDir,'assignment-capsule.mjs'),sourceBytes(sourceSha,RUNNER_PATH));

const artifactName=`overcenter-assignment-${requestCommentId}`;
const receipt={
  schema:'overcenter-github-agent-ingress-receipt/v1',
  request_comment_id:requestCommentId,
  authority_ref:authorityRef,
  authority_head:kernel.head(),
  obligation_id:work.id,
  work_revision:work.revision,
  run_id:work.run_id,
  claimed_revision:work.claimed_revision,
  source_sha:sourceSha,
  assignment_sha256:assignmentSha256(assignmentBytes),
  artifact_name:artifactName,
};
const serialized=`${JSON.stringify(receipt,null,2)}\n`;
writeFileSync(receiptPath,serialized);
writeFileSync(join(capsuleDir,'receipt.json'),serialized);

const githubOutput=process.env.GITHUB_OUTPUT;
if (githubOutput) {
  for (const [key,value] of Object.entries({
    artifact_name:artifactName,
    obligation_id:work.id,
    run_id:work.run_id,
    claimed_revision:work.claimed_revision,
    source_sha:sourceSha,
    assignment_sha256:receipt.assignment_sha256,
    authority_head:receipt.authority_head,
  })) {
    appendFileSync(githubOutput,`${key}=${String(value)}\n`);
  }
}

console.log(serialized.trim());
