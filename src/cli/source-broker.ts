import { readFileSync, writeFileSync } from 'node:fs';

import { brokerAssignedSourceProposal } from '../source/source-broker.ts';
import { appendGithubOutputs, commandOption } from './project-command-runtime.ts';

const assignmentPath = commandOption('--assignment');
const proposalPath = commandOption('--proposal');
if (!assignmentPath) throw new Error('--assignment_REQUIRES_VALUE');
if (!proposalPath) throw new Error('--proposal_REQUIRES_VALUE');

const assignment = JSON.parse(readFileSync(assignmentPath, 'utf8'));
const proposal = JSON.parse(readFileSync(proposalPath, 'utf8'));
const result = brokerAssignedSourceProposal(process.cwd(), assignment, proposal, {
  authorityRef: process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state',
  remote: process.env.OVERCENTER_PROJECT_REMOTE ?? 'origin',
  githubToken: process.env.GITHUB_TOKEN ?? null,
});
if (result.publication.state === 'CONFLICT') {
  throw new Error(
    `SOURCE_CANDIDATE_REF_CONFLICT:${result.publication.observed_sha}`,
  );
}

const output = `${JSON.stringify(result, null, 2)}\n`;
const outputPath = commandOption('--output');
if (outputPath) writeFileSync(outputPath, output);
else process.stdout.write(output);

appendGithubOutputs({
  authority_head: result.authority_head,
  candidate_sha: result.candidate.commit_sha,
  candidate_ref: result.publication.ref,
  publication_state: result.publication.state,
});
