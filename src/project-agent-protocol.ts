import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

import {
  AGENT_TASK_PACKET_SCHEMA,
  assignmentFile,
  assignmentSha256,
  buildAssignment,
  encodeAssignment,
  validateCandidate,
} from './assignment-capsule.ts';
import {canonicalDigest} from './digest.ts';
import {GitOvercenterKernel} from './git-kernel.ts';
import type {Work} from './model.ts';

export const PROJECT_ADVANCE_RECEIPT_SCHEMA='overcenter-project-advance/v1' as const;
export const AGENT_SUBMIT_RECEIPT_SCHEMA='overcenter-agent-submit/v1' as const;
export const PROJECT_ADVANCE_COMMAND='project.advance' as const;
export const AGENT_SUBMIT_COMMAND='agent.submit' as const;

type ProjectVisibleState=
  | 'READY'
  | 'EXECUTING'
  | 'WAITING'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'DONE'
  | 'AGENT_EXECUTION_REQUIRED';

export interface ProjectCommandContext {
  repository_id:number;
  repository_full_name:string;
  command_source_sha:string;
  command_run_id:number;
  command_run_attempt:number;
}

export interface ProjectAdvanceReceipt {
  schema:typeof PROJECT_ADVANCE_RECEIPT_SCHEMA;
  command:typeof PROJECT_ADVANCE_COMMAND;
  transport:'github-actions-job-rerun';
  repository_id:number;
  repository_full_name:string;
  command_source_sha:string;
  command_run_id:number;
  command_run_attempt:number;
  authority_ref:string;
  authority_head:string;
  state:ProjectVisibleState;
  obligation_id?:string;
  run_id?:string;
  claimed_revision?:string;
  assignment_sha256?:string;
  candidate_branch?:string;
  candidate_branch_base_sha?:string;
  receipt_digest:string;
}

export interface AgentSubmitContext extends ProjectCommandContext {
  candidate_sha:string;
}

export interface AgentSubmitReceipt {
  schema:typeof AGENT_SUBMIT_RECEIPT_SCHEMA;
  command:typeof AGENT_SUBMIT_COMMAND;
  transport:'github-actions-job-rerun';
  repository_id:number;
  repository_full_name:string;
  command_source_sha:string;
  command_run_id:number;
  command_run_attempt:number;
  authority_ref:string;
  authority_head:string;
  candidate_sha:string;
  obligation_id:string;
  run_id:string;
  claimed_revision:string;
  assignment_sha256:string;
  output_sha256:string;
  disposition:'DONE';
  verified:true;
  settlement_commit:string|null;
  already_settled:boolean;
  receipt_digest:string;
}

interface ProtocolOptions {
  authorityRef?:string;
  remote?:string;
  githubToken?:string|null;
}

interface AdvanceOptions extends ProtocolOptions {
  outputDir:string;
}

interface SubmitOptions extends ProtocolOptions {
  candidatePath?:string;
}

const DEFAULT_AUTHORITY_REF='refs/overcenter/state';
const DEFAULT_REMOTE='origin';
const DEFAULT_CANDIDATE_PATH='.overcenter/candidate.json';

function positiveInteger(value:number,name:string):void {
  if (!Number.isSafeInteger(value) || value<=0) {
    throw new Error(`PROJECT_AGENT_INTEGER_INVALID:${name}`);
  }
}

function validateCommandContext(context:ProjectCommandContext):void {
  positiveInteger(context.repository_id,'repository_id');
  positiveInteger(context.command_run_id,'command_run_id');
  positiveInteger(context.command_run_attempt,'command_run_attempt');
  if (context.command_run_attempt<2) {
    throw new Error('PROJECT_AGENT_COMMAND_NOT_INVOKED');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(context.repository_full_name)) {
    throw new Error('PROJECT_AGENT_REPOSITORY_INVALID');
  }
  if (!/^[0-9a-f]{40}$/i.test(context.command_source_sha)) {
    throw new Error('PROJECT_AGENT_COMMAND_SOURCE_INVALID');
  }
}

function sha256(bytes:Buffer):string {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

function gitBytes(repo:string,commit:string,path:string):Buffer {
  return execFileSync(
    'git',
    ['-C',repo,'show',`${commit}:${path}`],
    {maxBuffer:16*1024*1024},
  );
}

function agentAssignment(repo:string,work:Work):{
  bytes:Buffer;
  source_sha:string;
} {
  const packet=work.packet;
  if (
    packet.schema!==AGENT_TASK_PACKET_SCHEMA
    || packet.kind!=='pure-candidate'
  ) {
    throw new Error('PROJECT_ADVANCE_AGENT_PACKET_UNSUPPORTED');
  }

  const sourceSha=String(packet.source_sha??'').toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error('PROJECT_ADVANCE_PACKET_SOURCE_INVALID');
  }
  if (
    !Array.isArray(packet.required_paths)
    || packet.required_paths.length===0
    || packet.required_paths.some(path=>typeof path!=='string')
  ) {
    throw new Error('PROJECT_ADVANCE_REQUIRED_PATHS_INVALID');
  }

  const assignment=buildAssignment(
    work,
    packet.required_paths.map(path=>assignmentFile(
      path as string,
      gitBytes(repo,sourceSha,path as string),
    )),
  );
  const bytes=encodeAssignment(assignment);
  if (bytes.includes(Buffer.from('execution_capability'))) {
    throw new Error('PROJECT_ADVANCE_PACKET_LEAKED_EXECUTION_CAPABILITY');
  }
  return {bytes,source_sha:sourceSha};
}

function visibleState(work:Work[]):ProjectVisibleState {
  if (work.length===0 || work.every(candidate=>candidate.status==='DONE')) {
    return 'DONE';
  }
  for (const status of [
    'RECOVERY_REQUIRED',
    'EXECUTING',
    'WAITING',
    'BLOCKED',
    'READY',
  ] as const) {
    if (work.some(candidate=>candidate.status===status)) return status;
  }
  throw new Error('PROJECT_ADVANCE_STATE_UNCLASSIFIED');
}

function withDigest<T extends Record<string,unknown>>(base:T):T & {receipt_digest:string} {
  return {
    ...base,
    receipt_digest:canonicalDigest(base),
  };
}

export function advanceProjectForAgent(
  repo:string,
  context:ProjectCommandContext,
  {
    outputDir,
    authorityRef=DEFAULT_AUTHORITY_REF,
    remote=DEFAULT_REMOTE,
    githubToken=null,
  }:AdvanceOptions,
):ProjectAdvanceReceipt {
  validateCommandContext(context);
  const kernel=new GitOvercenterKernel(repo,{
    ref:authorityRef,
    remote,
    githubToken,
  });
  const startingHead=kernel.head();
  if (!startingHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');

  for (let attempt=0;attempt<16;attempt+=1) {
    const ready=kernel.deriveReadyWork();
    if (!ready) {
      const authorityHead=kernel.head();
      if (!authorityHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
      return withDigest({
        schema:PROJECT_ADVANCE_RECEIPT_SCHEMA,
        command:PROJECT_ADVANCE_COMMAND,
        transport:'github-actions-job-rerun' as const,
        repository_id:context.repository_id,
        repository_full_name:context.repository_full_name,
        command_source_sha:context.command_source_sha.toLowerCase(),
        command_run_id:context.command_run_id,
        command_run_attempt:context.command_run_attempt,
        authority_ref:authorityRef,
        authority_head:authorityHead,
        state:visibleState(kernel.inspect()),
      });
    }

    // The operator command does not ask the reasoning agent to choose work.
    // It only accepts a frontier item that is already an agent-shaped packet.
    agentAssignment(repo,ready);

    try {
      const permit=kernel.claim(ready.id,ready.revision);
      const claimed=kernel.claimedWork(permit.id);
      const assignment=agentAssignment(repo,claimed);
      const authorityHead=kernel.head();
      if (!authorityHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');

      rmSync(outputDir,{recursive:true,force:true});
      mkdirSync(outputDir,{recursive:true});
      writeFileSync(join(outputDir,'assignment.json'),assignment.bytes);

      const base={
        schema:PROJECT_ADVANCE_RECEIPT_SCHEMA,
        command:PROJECT_ADVANCE_COMMAND,
        transport:'github-actions-job-rerun' as const,
        repository_id:context.repository_id,
        repository_full_name:context.repository_full_name,
        command_source_sha:context.command_source_sha.toLowerCase(),
        command_run_id:context.command_run_id,
        command_run_attempt:context.command_run_attempt,
        authority_ref:authorityRef,
        authority_head:authorityHead,
        state:'AGENT_EXECUTION_REQUIRED' as const,
        obligation_id:claimed.id,
        run_id:permit.id,
        claimed_revision:permit.claimed_revision,
        assignment_sha256:assignmentSha256(assignment.bytes),
        candidate_branch:`overcenter/candidate/${permit.id}`,
        candidate_branch_base_sha:context.command_source_sha.toLowerCase(),
      };
      const receipt=withDigest(base);
      writeFileSync(
        join(outputDir,'receipt.json'),
        `${JSON.stringify(receipt,null,2)}\n`,
      );
      return receipt;
    } catch (error:unknown) {
      const message=error instanceof Error ? error.message : String(error);
      if (message==='STALE_REVISION' || message==='CLAIM_LOST') continue;
      throw error;
    }
  }
  throw new Error('PROJECT_ADVANCE_CONTENTION_EXHAUSTED');
}

function safeLocalObservationRoot(path:string):string {
  const target=resolve(path);
  const root=dirname(target);
  if (root==='/tmp' || dirname(root)!=='/tmp') {
    throw new Error('AGENT_SUBMIT_LOCAL_POSTCONDITION_UNSAFE');
  }
  return root;
}

export function submitProjectAgentCandidate(
  repo:string,
  context:AgentSubmitContext,
  {
    authorityRef=DEFAULT_AUTHORITY_REF,
    remote=DEFAULT_REMOTE,
    githubToken=null,
    candidatePath=DEFAULT_CANDIDATE_PATH,
  }:SubmitOptions={},
):AgentSubmitReceipt {
  validateCommandContext(context);
  const candidateSha=context.candidate_sha.toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error('AGENT_SUBMIT_CANDIDATE_SHA_INVALID');
  }

  const raw=JSON.parse(gitBytes(repo,candidateSha,candidatePath).toString('utf8'));
  if (!record(raw) || typeof raw.run_id!=='string') {
    throw new Error('AGENT_SUBMIT_CANDIDATE_RUN_INVALID');
  }

  const kernel=new GitOvercenterKernel(repo,{
    ref:authorityRef,
    remote,
    githubToken,
  });
  if (!kernel.head()) throw new Error('AGENT_SUBMIT_AUTHORITY_MISSING');

  const assigned=kernel.claimedWork(raw.run_id);
  const rebuilt=agentAssignment(repo,assigned);
  const candidate=validateCandidate(raw,JSON.parse(rebuilt.bytes.toString('utf8')),rebuilt.bytes);

  const priorDone=kernel.receipts(candidate.run_id)
    .filter(receipt=>receipt.disposition==='DONE' && receipt.verified)
    .at(-1);
  if (priorDone) {
    const diagnostic=record(priorDone.diagnostic)
      && record(priorDone.diagnostic.agent_candidate)
      ? priorDone.diagnostic.agent_candidate
      : null;
    if (
      !diagnostic
      || diagnostic.assignment_sha256!==candidate.assignment_sha256
      || diagnostic.output_sha256!==candidate.output_sha256
    ) {
      throw new Error('AGENT_SUBMIT_SETTLED_OUTPUT_MISMATCH');
    }
    const authorityHead=kernel.head();
    if (!authorityHead) throw new Error('AGENT_SUBMIT_AUTHORITY_MISSING');
    return withDigest({
      schema:AGENT_SUBMIT_RECEIPT_SCHEMA,
      command:AGENT_SUBMIT_COMMAND,
      transport:'github-actions-job-rerun' as const,
      repository_id:context.repository_id,
      repository_full_name:context.repository_full_name,
      command_source_sha:context.command_source_sha.toLowerCase(),
      command_run_id:context.command_run_id,
      command_run_attempt:context.command_run_attempt,
      authority_ref:authorityRef,
      authority_head:authorityHead,
      candidate_sha:candidateSha,
      obligation_id:assigned.id,
      run_id:candidate.run_id,
      claimed_revision:candidate.claimed_revision,
      assignment_sha256:candidate.assignment_sha256,
      output_sha256:candidate.output_sha256,
      disposition:'DONE' as const,
      verified:true as const,
      settlement_commit:priorDone.settlement_commit??null,
      already_settled:true,
    });
  }

  const current=kernel.inspect().find(work=>work.id===assigned.id);
  if (!current || current.run_id!==candidate.run_id) {
    throw new Error('AGENT_SUBMIT_AUTHORITY_RUN_MISMATCH');
  }
  if (!['EXECUTING','RECOVERY_REQUIRED'].includes(current.status)) {
    throw new Error(`AGENT_SUBMIT_RUN_NOT_SETTLEABLE:${current.status}`);
  }

  const postcondition=assigned.postcondition;
  if (
    postcondition.verifier!=='file-content-equals/v1'
    || typeof postcondition.path!=='string'
    || typeof postcondition.content!=='string'
  ) {
    throw new Error('AGENT_SUBMIT_POSTCONDITION_UNSUPPORTED');
  }

  const root=safeLocalObservationRoot(postcondition.path);
  rmSync(root,{recursive:true,force:true});
  mkdirSync(root,{recursive:true});
  const output=Buffer.from(candidate.output_base64,'base64');
  if (sha256(output)!==candidate.output_sha256) {
    throw new Error('AGENT_SUBMIT_OUTPUT_DIGEST_MISMATCH');
  }
  writeFileSync(postcondition.path,output,{flag:'wx'});

  const settlementKernel=new GitOvercenterKernel(repo,{
    ref:authorityRef,
    remote,
    githubToken,
    observationContext:{localFileRoot:root},
  });
  const before=settlementKernel.inspect().find(work=>work.id===assigned.id);
  if (!before || before.run_id!==candidate.run_id) {
    throw new Error('AGENT_SUBMIT_AUTHORITY_RUN_MISMATCH');
  }

  const permit=settlementKernel.acquireExecution(candidate.run_id);
  const settled=settlementKernel.resolve(permit,{
    agent_candidate:{
      assignment_sha256:candidate.assignment_sha256,
      output_sha256:candidate.output_sha256,
      candidate_sha:candidateSha,
    },
  });
  if (settled.disposition!=='DONE' || settled.verified!==true) {
    throw new Error(`AGENT_SUBMIT_CANDIDATE_NOT_VERIFIED:${settled.disposition}`);
  }

  const authorityHead=settlementKernel.head();
  if (!authorityHead) throw new Error('AGENT_SUBMIT_AUTHORITY_MISSING');
  return withDigest({
    schema:AGENT_SUBMIT_RECEIPT_SCHEMA,
    command:AGENT_SUBMIT_COMMAND,
    transport:'github-actions-job-rerun' as const,
    repository_id:context.repository_id,
    repository_full_name:context.repository_full_name,
    command_source_sha:context.command_source_sha.toLowerCase(),
    command_run_id:context.command_run_id,
    command_run_attempt:context.command_run_attempt,
    authority_ref:authorityRef,
    authority_head:authorityHead,
    candidate_sha:candidateSha,
    obligation_id:assigned.id,
    run_id:candidate.run_id,
    claimed_revision:candidate.claimed_revision,
    assignment_sha256:candidate.assignment_sha256,
    output_sha256:candidate.output_sha256,
    disposition:'DONE' as const,
    verified:true as const,
    settlement_commit:settled.settlement_commit??null,
    already_settled:false,
  });
}
