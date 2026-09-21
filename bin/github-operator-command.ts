import {appendFileSync} from 'node:fs';

import {
  CANDIDATE_CERTIFY_COMMAND,
  executeGithubOperatorCommand,
  type GithubOperatorCommandContext,
} from '../src/github-operator-command.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveInteger(name:string):number {
  const value=Number(required(name));
  if (!Number.isSafeInteger(value) || value<=0) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

const [command]=process.argv.slice(2);
if (command!==CANDIDATE_CERTIFY_COMMAND) {
  throw new Error('usage: github-operator-command.ts candidate.certify');
}

const context:GithubOperatorCommandContext={
  repository_id:positiveInteger('OVERCENTER_COMMAND_REPOSITORY_ID'),
  repository_full_name:required('OVERCENTER_COMMAND_REPOSITORY'),
  head_repository_full_name:required('OVERCENTER_COMMAND_HEAD_REPOSITORY'),
  pull_number:positiveInteger('OVERCENTER_COMMAND_PULL_NUMBER'),
  source_sha:required('OVERCENTER_COMMAND_SOURCE_SHA'),
  ref:required('OVERCENTER_COMMAND_REF'),
  command_run_id:positiveInteger('OVERCENTER_COMMAND_RUN_ID'),
  command_run_attempt:positiveInteger('OVERCENTER_COMMAND_RUN_ATTEMPT'),
};

const receipt=await executeGithubOperatorCommand(
  required('GITHUB_TOKEN'),
  command,
  context,
);
const serialized=JSON.stringify(receipt,null,2);
console.log(serialized);

const output=process.env.GITHUB_OUTPUT;
if (output) {
  for (const [key,value] of Object.entries({
    command:receipt.command,
    source_sha:receipt.source_sha,
    dispatched_run_id:receipt.dispatched_run_id,
    dispatched_run_url:receipt.dispatched_run_url,
    dispatched_html_url:receipt.dispatched_html_url,
    receipt_digest:receipt.receipt_digest,
  })) {
    appendFileSync(output,`${key}=${String(value)}\n`);
  }
}
