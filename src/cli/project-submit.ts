import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {submitProjectCandidate} from '../authority/project-agent-protocol.ts';
import {commandContext,githubOutput,option,required} from './common.ts';

const receiptPath=option('--receipt');
if (!receiptPath) throw new Error('usage: project-submit.ts --receipt <path>');

const receipt=submitProjectCandidate(process.cwd(),{
  ...commandContext(),
  candidate_sha:required('OVERCENTER_CANDIDATE_SHA'),
},{
  authorityRef:process.env.OVERCENTER_PROJECT_AUTHORITY_REF,
  remote:process.env.OVERCENTER_PROJECT_REMOTE,
  githubToken:process.env.GITHUB_TOKEN??null,
});
mkdirSync(dirname(receiptPath),{recursive:true});
writeFileSync(receiptPath,`${JSON.stringify(receipt,null,2)}\n`);
console.log(JSON.stringify(receipt,null,2));
githubOutput({
  disposition:receipt.disposition,
  verified:String(receipt.verified),
  authority_head:receipt.authority_head,
  obligation_id:receipt.obligation_id,
  run_id:receipt.run_id,
  settlement_commit:receipt.settlement_commit??'',
  already_settled:String(receipt.already_settled),
  receipt_digest:receipt.receipt_digest,
});
