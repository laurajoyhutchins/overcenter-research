import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

import {OvercenterKernel} from '../../src/kernel.ts';

const ASSIGNMENT_SCHEMA='overcenter-codex-closed-loop-assignment/v1';
const CANDIDATE_SCHEMA='overcenter-codex-closed-loop-candidate/v1';

const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

const [database,assignmentPath,candidatePath,patchPath,workspace]=process.argv.slice(2);
if (!database || !assignmentPath || !candidatePath || !patchPath || !workspace) {
  throw new Error('usage: settle.ts <authority.sqlite> <assignment.json> <candidate.json> <candidate.patch> <workspace>');
}

const assignmentBytes=readFileSync(assignmentPath);
const assignment=JSON.parse(assignmentBytes.toString('utf8')) as Record<string,any>;
const candidate=JSON.parse(readFileSync(candidatePath,'utf8')) as Record<string,any>;
const patchBytes=readFileSync(patchPath);

if (assignment.schema!==ASSIGNMENT_SCHEMA) throw new Error('CODEX_CLOSED_LOOP_ASSIGNMENT_SCHEMA_MISMATCH');
if (candidate.schema!==CANDIDATE_SCHEMA) throw new Error('CODEX_CLOSED_LOOP_CANDIDATE_SCHEMA_MISMATCH');
if (candidate.assignment_sha256!==sha256(assignmentBytes)) throw new Error('CODEX_CLOSED_LOOP_ASSIGNMENT_DIGEST_MISMATCH');
if (candidate.patch_sha256!==sha256(patchBytes)) throw new Error('CODEX_CLOSED_LOOP_PATCH_DIGEST_MISMATCH');
if (candidate.source_sha!==assignment.source_sha) throw new Error('CODEX_CLOSED_LOOP_SOURCE_MISMATCH');
if (candidate.target_path!==assignment.target_path) throw new Error('CODEX_CLOSED_LOOP_TARGET_MISMATCH');
if (candidate.run_id!==assignment.work?.run_id) throw new Error('CODEX_CLOSED_LOOP_RUN_MISMATCH');
if (candidate.claimed_revision!==assignment.work?.claimed_revision) {
  throw new Error('CODEX_CLOSED_LOOP_REVISION_MISMATCH');
}

const expected=Buffer.from(String(assignment.expected_content_base64),'base64');
const target=readFileSync(join(workspace,...String(assignment.target_path).split('/')));
if (!target.equals(expected)) throw new Error('CODEX_CLOSED_LOOP_POSTCONDITION_BYTES_MISMATCH');

const postcondition=assignment.work?.postcondition;
if (
  !postcondition
  || postcondition.verifier!=='file-content-equals/v1'
  || typeof postcondition.path!=='string'
  || typeof postcondition.content!=='string'
) {
  throw new Error('CODEX_CLOSED_LOOP_POSTCONDITION_INVALID');
}

const root=dirname(postcondition.path);
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});
writeFileSync(postcondition.path,target,{flag:'wx'});

const kernel=new OvercenterKernel(database,{observationContext:{localFileRoot:root}});
try {
  const before=kernel.inspect().find(work=>work.id===assignment.work.id);
  if (!before || before.status!=='EXECUTING') throw new Error('CODEX_CLOSED_LOOP_RUN_NOT_EXECUTING');
  if (before.run_id!==candidate.run_id) throw new Error('CODEX_CLOSED_LOOP_AUTHORITY_RUN_MISMATCH');
  if (before.claimed_revision!==candidate.claimed_revision) {
    throw new Error('CODEX_CLOSED_LOOP_AUTHORITY_REVISION_MISMATCH');
  }

  const permit=kernel.acquireExecution(candidate.run_id);
  const receipt=kernel.resolve(permit,{
    codex_candidate:{
      assignment_sha256:candidate.assignment_sha256,
      patch_sha256:candidate.patch_sha256,
    },
  });
  if (receipt.disposition!=='DONE' || receipt.verified!==true) {
    throw new Error(`CODEX_CLOSED_LOOP_DID_NOT_SETTLE:${receipt.disposition}`);
  }
  const after=kernel.inspect().find(work=>work.id===assignment.work.id);
  if (!after || after.status!=='DONE') throw new Error('CODEX_CLOSED_LOOP_FINAL_STATE_NOT_DONE');

  console.log(JSON.stringify({
    obligation_id:after.id,
    run_id:candidate.run_id,
    assignment_sha256:candidate.assignment_sha256,
    patch_sha256:candidate.patch_sha256,
    disposition:receipt.disposition,
    verified:receipt.verified,
  }));
} finally {
  kernel.close();
}
