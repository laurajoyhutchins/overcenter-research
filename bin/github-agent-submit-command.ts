import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {
  submitProjectAgentCandidate,
  type AgentSubmitContext,
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

const receiptPath=option('--receipt');
if (!receiptPath) {
  throw new Error('usage: github-agent-submit-command.ts --receipt <path>');
}

const context:AgentSubmitContext={
  repository_id:positiveInteger('OVERCENTER_COMMAND_REPOSITORY_ID'),
  repository_full_name:required('OVERCENTER_COMMAND_REPOSITORY'),
  command_source_sha:required('OVERCENTER_COMMAND_SOURCE_SHA'),
  command_run_id:positiveInteger('OVERCENTER_COMMAND_RUN_ID'),
  command_run_attempt:positiveInteger('OVERCENTER_COMMAND_RUN_ATTEMPT'),
  candidate_sha:required('OVERCENTER_CANDIDATE_SHA'),
};

const receipt=submitProjectAgentCandidate(process.cwd(),context,{
  authorityRef:process.env.OVERCENTER_PROJECT_AUTHORITY_REF,
  remote:process.env.OVERCENTER_PROJECT_REMOTE,
  githubToken:process.env.GITHUB_TOKEN??null,
});
mkdirSync(dirname(receiptPath),{recursive:true});
writeFileSync(receiptPath,`${JSON.stringify(receipt,null,2)}\n`);
console.log(JSON.stringify(receipt,null,2));

const output=process.env.GITHUB_OUTPUT;
if (output) {
  for (const [key,value] of Object.entries({
    disposition:receipt.disposition,
    verified:String(receipt.verified),
    authority_head:receipt.authority_head,
    obligation_id:receipt.obligation_id,
    run_id:receipt.run_id,
    settlement_commit:receipt.settlement_commit??'',
    already_settled:String(receipt.already_settled),
    receipt_digest:receipt.receipt_digest,
  })) {
    appendFileSync(output,`${key}=${String(value)}\n`);
  }
}
