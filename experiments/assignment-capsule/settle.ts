import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {OvercenterKernel} from '../../src/kernel.ts';
import {validateAssignment,validateCandidate} from '../../src/assignment-capsule.mjs';

const [database,assignmentPath,candidatePath]=process.argv.slice(2);
if (!database || !assignmentPath || !candidatePath) {
  throw new Error('usage: settle.ts <authority.sqlite> <assignment.json> <candidate.json>');
}

const assignmentBytes=readFileSync(assignmentPath);
const assignment=validateAssignment(JSON.parse(assignmentBytes.toString('utf8')));
const candidate=validateCandidate(
  JSON.parse(readFileSync(candidatePath,'utf8')),
  assignment,
  assignmentBytes,
);
const postcondition=assignment.work.postcondition;
if (
  !postcondition
  || postcondition.verifier!=='file-content-equals/v1'
  || typeof postcondition.path!=='string'
  || typeof postcondition.content!=='string'
) {
  throw new Error('ASSIGNMENT_POSTCONDITION_INVALID');
}

const output=Buffer.from(candidate.output_base64,'base64');
const root=dirname(postcondition.path);
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});
writeFileSync(postcondition.path,output,{flag:'wx'});

const kernel=new OvercenterKernel(database,{observationContext:{localFileRoot:root}});
try {
  const before=kernel.inspect().find(work=>work.id===assignment.work.id);
  if (!before || before.status!=='EXECUTING') throw new Error('ASSIGNMENT_RUN_NOT_EXECUTING');
  if (before.run_id!==candidate.run_id) throw new Error('ASSIGNMENT_AUTHORITY_RUN_MISMATCH');
  if (before.claimed_revision!==candidate.claimed_revision) {
    throw new Error('ASSIGNMENT_AUTHORITY_REVISION_MISMATCH');
  }

  const permit=kernel.acquireExecution(candidate.run_id);
  const receipt=kernel.resolve(permit,{
    assignment_candidate:{
      assignment_sha256:candidate.assignment_sha256,
      output_sha256:candidate.output_sha256,
    },
  });
  if (receipt.disposition!=='DONE' || receipt.verified!==true) {
    throw new Error(`ASSIGNMENT_DID_NOT_SETTLE:${receipt.disposition}`);
  }
  const after=kernel.inspect().find(work=>work.id===assignment.work.id);
  if (!after || after.status!=='DONE') throw new Error('ASSIGNMENT_FINAL_STATE_NOT_DONE');

  console.log(JSON.stringify({
    obligation_id:after.id,
    run_id:candidate.run_id,
    worker_generation:assignment.work.execution_generation,
    settlement_generation:permit.execution_generation,
    assignment_sha256:candidate.assignment_sha256,
    output_sha256:candidate.output_sha256,
    disposition:receipt.disposition,
    verified:receipt.verified,
  }));
} finally {
  kernel.close();
}
