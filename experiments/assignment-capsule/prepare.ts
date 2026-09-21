import {copyFileSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

import {OvercenterKernel} from '../../src/kernel.ts';
import {POSTCONDITION_VERIFIERS} from '../../src/generated/schema-identifiers.ts';
import {
  AGENT_TASK_PACKET_SCHEMA,
  assignmentFile,
  buildAssignment,
  encodeAssignment,
} from '../../src/assignment-capsule.mjs';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const [database,capsuleDir]=process.argv.slice(2);
if (!database || !capsuleDir) {
  throw new Error('usage: prepare.ts <authority.sqlite> <capsule-dir>');
}

const runId=required('GITHUB_RUN_ID');
const runAttempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('SOURCE_SHA');
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID');
const obligationId=`assignment-capsule-${runId}-${runAttempt}`;
const settlementRoot=`/tmp/overcenter-assignment-capsule-${runId}-${runAttempt}`;
const resultPath=join(settlementRoot,'result.txt');
const taskBytes=readFileSync(new URL('./fixture-task.mjs',import.meta.url));
const inputBytes=readFileSync(new URL('./fixture-input.txt',import.meta.url));
const expectedOutput=`completed:${inputBytes.toString('utf8').trim()}\n`;

rmSync(capsuleDir,{recursive:true,force:true});
mkdirSync(capsuleDir,{recursive:true});
mkdirSync(dirname(database),{recursive:true});

const kernel=new OvercenterKernel(database);
try {
  kernel.initialize();
  kernel.define({
    id:obligationId,
    packet:{
      schema:AGENT_TASK_PACKET_SCHEMA,
      kind:'pure-candidate',
      source_sha:sourceSha,
      command:['node','task.mjs','input.txt','result.txt'],
      required_paths:['task.mjs','input.txt'],
      output_path:'result.txt',
    },
    postcondition:{
      verifier:POSTCONDITION_VERIFIERS.fileContentEquals,
      path:resultPath,
      content:expectedOutput,
    },
  });

  const ready=kernel.deriveReadyWork();
  if (!ready || ready.id!==obligationId) throw new Error('ASSIGNMENT_READY_WORK_MISSING');
  const permit=kernel.claim(ready.id,ready.revision);
  const assigned=kernel.inspect().find(work=>work.id===obligationId);
  if (!assigned || assigned.status!=='EXECUTING') throw new Error('ASSIGNMENT_NOT_EXECUTING');
  if (assigned.run_id!==permit.id) throw new Error('ASSIGNMENT_RUN_MISMATCH');
  if (assigned.claimed_revision!==permit.claimed_revision) throw new Error('ASSIGNMENT_REVISION_MISMATCH');

  const assignment=buildAssignment(assigned,[
    assignmentFile('task.mjs',taskBytes),
    assignmentFile('input.txt',inputBytes),
  ]);
  const encoded=encodeAssignment(assignment);
  if (encoded.includes(Buffer.from('execution_capability'))) {
    throw new Error('ASSIGNMENT_LEAKED_EXECUTION_CAPABILITY');
  }

  writeFileSync(join(capsuleDir,'assignment.json'),encoded);
  copyFileSync(
    new URL('../../src/assignment-capsule.mjs',import.meta.url),
    join(capsuleDir,'assignment-capsule.mjs'),
  );
  copyFileSync(
    new URL('../../src/schema-identifiers.generated.mjs',import.meta.url),
    join(capsuleDir,'schema-identifiers.generated.mjs'),
  );

  console.log(JSON.stringify({
    obligation_id:obligationId,
    run_id:permit.id,
    claimed_revision:permit.claimed_revision,
    status:assigned.status,
    source_sha:sourceSha,
    task_bytes:taskBytes.length,
    input_bytes:inputBytes.length,
    assignment_bytes:encoded.length,
  }));
} finally {
  kernel.close();
}
