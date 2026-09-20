import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {OvercenterKernel} from '../../src/kernel.ts';

const ASSIGNMENT_SCHEMA='overcenter-codex-closed-loop-assignment/v1';
const TASK_SCHEMA='overcenter-codex-closed-loop-task/v1';
const TARGET_PATH='experiments/codex-closed-loop/witness.txt';
const EXPECTED='codex-closed-loop:after\n';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const [database,assignmentPath]=process.argv.slice(2);
if (!database || !assignmentPath) {
  throw new Error('usage: prepare.ts <authority.sqlite> <assignment.json>');
}

const runId=required('GITHUB_RUN_ID');
const runAttempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('SOURCE_SHA').toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID');

const obligationId=`codex-closed-loop-${runId}-${runAttempt}`;
const observedPath=`/tmp/${obligationId}/witness.txt`;

mkdirSync(dirname(database),{recursive:true});
mkdirSync(dirname(assignmentPath),{recursive:true});

const kernel=new OvercenterKernel(database);
try {
  kernel.initialize();
  kernel.define({
    id:obligationId,
    packet:{
      schema:TASK_SCHEMA,
      source_sha:sourceSha,
      target_path:TARGET_PATH,
      instruction:`Replace the complete contents of ${TARGET_PATH} with exactly ${JSON.stringify(EXPECTED)}. Change no other tracked or untracked file.`,
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:observedPath,
      content:EXPECTED,
    },
  });

  const ready=kernel.nextReadyWork();
  if (!ready || ready.id!==obligationId) throw new Error('CODEX_CLOSED_LOOP_READY_WORK_MISSING');
  kernel.claim(ready.id,ready.revision);
  const work=kernel.inspect().find(candidate=>candidate.id===obligationId);
  if (!work || work.status!=='EXECUTING') throw new Error('CODEX_CLOSED_LOOP_CLAIM_FAILED');
  if (!work.run_id || !work.claimed_revision) throw new Error('CODEX_CLOSED_LOOP_CLAIM_IDENTITY_MISSING');

  const assignment={
    schema:ASSIGNMENT_SCHEMA,
    source_sha:sourceSha,
    target_path:TARGET_PATH,
    expected_content_base64:Buffer.from(EXPECTED,'utf8').toString('base64'),
    instruction:(work.packet as Record<string,unknown>).instruction,
    work,
  };
  writeFileSync(assignmentPath,`${JSON.stringify(assignment,null,2)}\n`,'utf8');

  const output=process.env.GITHUB_OUTPUT;
  if (output) {
    writeFileSync(output,[
      `obligation_id=${work.id}`,
      `run_id=${work.run_id}`,
      `claimed_revision=${work.claimed_revision}`,
      `target_path=${TARGET_PATH}`,
      '',
    ].join('\n'),{flag:'a'});
  }
} finally {
  kernel.close();
}
