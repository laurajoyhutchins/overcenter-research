import {appendFileSync} from 'node:fs';

import {
  advanceProjectForAgent,
  type ProjectCommandContext,
} from '../src/project-agent-protocol.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveInteger(name:string):number {
  const value=Number(required(name));
  if (!Number.isSafeInteger(value) || value<=0) throw new Error(`${name}_INVALID`);
  return value;
}

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

const outputDir=option('--output-dir');
if (!outputDir) {
  throw new Error('usage: github-project-advance.ts --output-dir <dir>');
}

const context:ProjectCommandContext={
  repository_id:positiveInteger('OVERCENTER_COMMAND_REPOSITORY_ID'),
  repository_full_name:required('OVERCENTER_COMMAND_REPOSITORY'),
  command_source_sha:required('OVERCENTER_COMMAND_SOURCE_SHA'),
  command_run_id:positiveInteger('OVERCENTER_COMMAND_RUN_ID'),
  command_run_attempt:positiveInteger('OVERCENTER_COMMAND_RUN_ATTEMPT'),
};

const receipt=advanceProjectForAgent(process.cwd(),context,{
  outputDir,
  authorityRef:process.env.OVERCENTER_PROJECT_AUTHORITY_REF,
  remote:process.env.OVERCENTER_PROJECT_REMOTE,
  githubToken:process.env.GITHUB_TOKEN??null,
});
console.log(JSON.stringify(receipt,null,2));

const output=process.env.GITHUB_OUTPUT;
if (output) {
  for (const [key,value] of Object.entries({
    state:receipt.state,
    authority_head:receipt.authority_head,
    obligation_id:receipt.obligation_id??'',
    run_id:receipt.run_id??'',
    claimed_revision:receipt.claimed_revision??'',
    assignment_sha256:receipt.assignment_sha256??'',
    candidate_branch:receipt.candidate_branch??'',
    candidate_branch_base_sha:receipt.candidate_branch_base_sha??'',
    receipt_digest:receipt.receipt_digest,
  })) {
    appendFileSync(output,`${key}=${String(value)}\n`);
  }
}
