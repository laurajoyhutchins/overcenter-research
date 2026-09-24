import { canonicalDigest } from '../digest.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import {
  brokerSourceProposal,
  type SourceCandidatePublicationResult,
} from './source-integration.ts';
import { validateSourceAssignment, type SourceCandidate } from './source-obligation.ts';

export interface BrokeredAssignedSourceProposal {
  authority_head: string;
  candidate: SourceCandidate;
  publication: SourceCandidatePublicationResult;
}

export function brokerAssignedSourceProposal(
  repo: string,
  assignmentValue: unknown,
  proposalValue: unknown,
  {
    authorityRef = 'refs/overcenter/state',
    remote = 'origin',
    githubToken = null,
  }: {
    authorityRef?: string;
    remote?: string;
    githubToken?: string | null;
  } = {},
): BrokeredAssignedSourceProposal {
  const assignment = validateSourceAssignment(assignmentValue);
  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
  });
  const authorityHead = kernel.head();
  if (!authorityHead) throw new Error('SOURCE_BROKER_AUTHORITY_MISSING');

  const current = kernel
    .inspect()
    .find(
      (work) => work.id === assignment.obligation_id && work.run_id === assignment.claim.run_id,
    );
  if (!current || current.status !== 'EXECUTING') {
    throw new Error('SOURCE_BROKER_RUN_NOT_EXECUTING');
  }
  if (
    current.packet.kind !== 'source-change' ||
    current.postcondition.verifier !== 'source-integration/v1'
  ) {
    throw new Error('SOURCE_BROKER_WORK_INVALID');
  }

  const claim = kernel.sourceClaimBinding(assignment.claim.run_id);
  if (
    claim.obligation_key !== assignment.claim.obligation_key ||
    claim.run_id !== assignment.claim.run_id ||
    claim.claimed_revision !== assignment.claim.claimed_revision ||
    claim.source_sha !== assignment.claim.source_sha
  ) {
    throw new Error('SOURCE_BROKER_ASSIGNMENT_STALE');
  }
  if (canonicalDigest(current.packet) !== canonicalDigest(assignment.task)) {
    throw new Error('SOURCE_BROKER_TASK_MISMATCH');
  }

  const brokered = brokerSourceProposal(repo, current.packet, claim, proposalValue, { remote });
  return {
    authority_head: authorityHead,
    candidate: brokered.candidate,
    publication: brokered.publication,
  };
}
