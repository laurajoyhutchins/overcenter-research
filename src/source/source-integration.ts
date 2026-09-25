import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import {
  SOURCE_CANDIDATE_SCHEMA,
  validateSourceCandidate,
  validateSourceProposal,
  validateSourceTaskPacket,
  type SourceCandidate,
  type SourceClaimBinding,
  type SourceTaskPacket,
} from './source-obligation.ts';

export const SOURCE_VERIFICATION_SCHEMA = 'overcenter-source-verification/v1' as const;
export const SOURCE_INTEGRATION_EVIDENCE_SCHEMA =
  'overcenter-source-integration-evidence/v1' as const;

export interface SourceVerification {
  schema: typeof SOURCE_VERIFICATION_SCHEMA;
  state: 'verified' | 'rejected';
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  tree_sha: string | null;
  reason: string | null;
}

export interface SourceIntegrationEvidence {
  schema: typeof SOURCE_INTEGRATION_EVIDENCE_SCHEMA;
  run_id: string;
  obligation_key: string;
  source_sha: string;
  candidate_sha: string;
  verification_base_sha: string;
  verified_tree_sha: string;
  integration_commit: string;
  state: 'integrated' | 'already-integrated';
}

const sourceIntegrationWitnessBrand: unique symbol = Symbol('source-integration-witness');
const sourceIntegrationEvidenceByWitness = new WeakMap<object, SourceIntegrationEvidence>();

export type TrustedSourceIntegrationWitness = {
  readonly [sourceIntegrationWitnessBrand]: true;
};

export type SourceIntegrationResult =
  | {
      state: 'INTEGRATED' | 'ALREADY_INTEGRATED';
      witness: TrustedSourceIntegrationWitness;
      commit_sha: string;
    }
  | {
      state: 'REREALIZE_REQUIRED' | 'REJECTED' | 'RECOVERY_REQUIRED';
      reason: string;
    };

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitStatus(repo: string, args: string[]): number {
  return spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status ?? 1;
}

function remoteRefHead(repo: string, remote: string, ref: string): string | null {
  const listed = execFileSync('git', ['-C', repo, 'ls-remote', remote, ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!listed) return null;
  const sha = listed.split(/\s+/)[0] ?? '';
  exactSha(sha, 'SOURCE_AUTHORITY_HEAD_INVALID');
  execFileSync(
    'git',
    ['-C', repo, 'fetch', '--no-tags', remote, `+${ref}:refs/overcenter/source-main-observed`],
    { stdio: 'ignore' },
  );
  return sha;
}

function remoteRefCas(
  repo: string,
  remote: string,
  ref: string,
  next: string,
  expected: string,
): boolean {
  return (
    gitStatus(repo, [
      'push',
      '--porcelain',
      `--force-with-lease=${ref}:${expected}`,
      remote,
      `${next}:${ref}`,
    ]) === 0
  );
}

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

function sourceControlPath(path: string): boolean {
  return (
    path === '.overcenter' ||
    path.startsWith('.overcenter/') ||
    path === '.github' ||
    path.startsWith('.github/')
  );
}

export function validateSourceVerification(value: unknown): SourceVerification {
  if (!isData(value)) throw new Error('SOURCE_VERIFICATION_INVALID');
  assertExactKeys(
    value,
    ['schema', 'state', 'run_id', 'candidate_sha', 'base_sha', 'tree_sha', 'reason'],
    [],
    'SOURCE_VERIFICATION_INVALID',
  );
  if (value.schema !== SOURCE_VERIFICATION_SCHEMA) {
    throw new Error('SOURCE_VERIFICATION_SCHEMA_MISMATCH');
  }
  if (value.state !== 'verified' && value.state !== 'rejected') {
    throw new Error('SOURCE_VERIFICATION_STATE_INVALID');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_VERIFICATION_RUN_ID_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_VERIFICATION_CANDIDATE_SHA_INVALID');
  exactSha(value.base_sha, 'SOURCE_VERIFICATION_BASE_SHA_INVALID');
  if (value.state === 'verified') {
    exactSha(value.tree_sha, 'SOURCE_VERIFICATION_TREE_SHA_INVALID');
    if (value.reason !== null) throw new Error('SOURCE_VERIFICATION_REASON_INVALID');
  } else {
    if (value.tree_sha !== null) throw new Error('SOURCE_VERIFICATION_TREE_INVALID');
    assertNonEmptyString(value.reason, 'SOURCE_VERIFICATION_REASON_INVALID');
  }
  return {
    schema: SOURCE_VERIFICATION_SCHEMA,
    state: value.state,
    run_id: value.run_id,
    candidate_sha: value.candidate_sha,
    base_sha: value.base_sha,
    tree_sha: value.tree_sha,
    reason: value.reason,
  };
}

export function validateSourceIntegrationEvidence(value: unknown): SourceIntegrationEvidence {
  if (!isData(value)) throw new Error('SOURCE_INTEGRATION_EVIDENCE_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'run_id',
      'obligation_key',
      'source_sha',
      'candidate_sha',
      'verification_base_sha',
      'verified_tree_sha',
      'integration_commit',
      'state',
    ],
    [],
    'SOURCE_INTEGRATION_EVIDENCE_INVALID',
  );
  if (value.schema !== SOURCE_INTEGRATION_EVIDENCE_SCHEMA) {
    throw new Error('SOURCE_INTEGRATION_EVIDENCE_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_INTEGRATION_EVIDENCE_RUN_INVALID');
  assertNonEmptyString(value.obligation_key, 'SOURCE_INTEGRATION_EVIDENCE_KEY_INVALID');
  exactSha(value.source_sha, 'SOURCE_INTEGRATION_EVIDENCE_SOURCE_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_INTEGRATION_EVIDENCE_CANDIDATE_INVALID');
  exactSha(value.verification_base_sha, 'SOURCE_INTEGRATION_EVIDENCE_BASE_INVALID');
  exactSha(value.verified_tree_sha, 'SOURCE_INTEGRATION_EVIDENCE_TREE_INVALID');
  exactSha(value.integration_commit, 'SOURCE_INTEGRATION_EVIDENCE_COMMIT_INVALID');
  if (value.state !== 'integrated' && value.state !== 'already-integrated') {
    throw new Error('SOURCE_INTEGRATION_EVIDENCE_STATE_INVALID');
  }
  return structuredClone(value) as unknown as SourceIntegrationEvidence;
}

function mintSourceIntegrationWitness(
  evidence: SourceIntegrationEvidence,
): TrustedSourceIntegrationWitness {
  const witness = Object.freeze({
    [sourceIntegrationWitnessBrand]: true as const,
  });
  sourceIntegrationEvidenceByWitness.set(witness, validateSourceIntegrationEvidence(evidence));
  return witness;
}

export function trustedSourceIntegrationEvidence(
  witness: TrustedSourceIntegrationWitness,
): SourceIntegrationEvidence {
  const evidence = sourceIntegrationEvidenceByWitness.get(witness);
  if (!evidence) throw new Error('SOURCE_INTEGRATION_WITNESS_INVALID');
  return structuredClone(evidence);
}

export type SourceCandidatePublicationResult =
  | { state: 'PUBLISHED' | 'ALREADY_PUBLISHED'; ref: string; candidate_sha: string }
  | { state: 'CONFLICT'; ref: string; observed_sha: string };

function sourceCandidateMessage(claim: SourceClaimBinding): string {
  return [
    `source candidate ${claim.run_id}`,
    '',
    `Overcenter-Obligation-Key: ${claim.obligation_key}`,
    `Overcenter-Claimed-Revision: ${claim.claimed_revision}`,
    `Overcenter-Claimed-Source: ${claim.source_sha}`,
  ].join('\n');
}

function materializeSourceProposal(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  proposalValue: unknown,
): SourceCandidate {
  const proposal = validateSourceProposal(proposalValue, taskValue, claim);
  const candidateTree = worktree(repo, claim.source_sha);
  let candidateSha = '';
  try {
    for (const file of proposal.files) {
      const target = join(candidateTree.root, file.path);
      if (file.content_base64 === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(file.content_base64, 'base64'));
      }
    }
    git(candidateTree.root, ['add', '-A', '--', ...proposal.files.map((file) => file.path)]);
    if (gitStatus(candidateTree.root, ['diff', '--cached', '--quiet']) === 0) {
      throw new Error('SOURCE_PROPOSAL_EMPTY');
    }
    git(candidateTree.root, [
      '-c',
      'user.name=Overcenter Source Broker',
      '-c',
      'user.email=overcenter@local',
      'commit',
      '-m',
      sourceCandidateMessage(claim),
    ]);
    candidateSha = git(candidateTree.root, ['rev-parse', 'HEAD']);
  } finally {
    candidateTree.dispose();
  }

  return inspectSourceCandidate(repo, taskValue, claim, candidateSha).candidate;
}

function publishSourceCandidate(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  candidateSha: string,
  { remote = 'origin' }: { remote?: string } = {},
): SourceCandidatePublicationResult {
  inspectSourceCandidate(repo, taskValue, claim, candidateSha);
  const ref = `refs/heads/overcenter/candidate/${claim.run_id}`;
  const listed = execFileSync('git', ['-C', repo, 'ls-remote', remote, ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (listed) {
    const observed = listed.split(/\s+/)[0] ?? '';
    exactSha(observed, 'SOURCE_CANDIDATE_REF_INVALID');
    if (observed === candidateSha) {
      return { state: 'ALREADY_PUBLISHED', ref, candidate_sha: candidateSha };
    }
    return { state: 'CONFLICT', ref, observed_sha: observed };
  }

  if (gitStatus(repo, ['push', '--porcelain', remote, `${candidateSha}:${ref}`]) === 0) {
    return { state: 'PUBLISHED', ref, candidate_sha: candidateSha };
  }

  const after = execFileSync('git', ['-C', repo, 'ls-remote', remote, ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!after) throw new Error('SOURCE_CANDIDATE_PUBLICATION_UNCERTAIN');
  const observed = after.split(/\s+/)[0] ?? '';
  exactSha(observed, 'SOURCE_CANDIDATE_REF_INVALID');
  if (observed === candidateSha) {
    return { state: 'ALREADY_PUBLISHED', ref, candidate_sha: candidateSha };
  }
  return { state: 'CONFLICT', ref, observed_sha: observed };
}

export function brokerSourceProposal(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  proposalValue: unknown,
  { remote = 'origin' }: { remote?: string } = {},
): {
  candidate: SourceCandidate;
  publication: SourceCandidatePublicationResult;
} {
  const candidate = materializeSourceProposal(repo, taskValue, claim, proposalValue);
  const publication = publishSourceCandidate(repo, taskValue, claim, candidate.commit_sha, {
    remote,
  });
  return { candidate, publication };
}

export function inspectSourceCandidate(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  candidateSha: string,
): { task: SourceTaskPacket; candidate: SourceCandidate; changed_paths: string[] } {
  const task = validateSourceTaskPacket(taskValue);
  exactSha(candidateSha, 'SOURCE_CANDIDATE_COMMIT_SHA_INVALID');

  const parents = git(repo, ['rev-list', '--parents', '-n', '1', candidateSha])
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2 || parents[1] !== claim.source_sha) {
    throw new Error('SOURCE_CANDIDATE_PARENT_MISMATCH');
  }

  const candidate = validateSourceCandidate(
    {
      schema: SOURCE_CANDIDATE_SCHEMA,
      obligation_key: claim.obligation_key,
      run_id: claim.run_id,
      claimed_revision: claim.claimed_revision,
      claimed_source_sha: claim.source_sha,
      commit_sha: candidateSha,
    },
    claim,
  );

  const changed = git(repo, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '--no-renames',
    '-r',
    candidateSha,
  ]);
  const changedPaths = changed ? changed.split('\n').sort() : [];
  if (changedPaths.length === 0) throw new Error('SOURCE_CANDIDATE_EMPTY');
  if (changedPaths.some(sourceControlPath)) {
    throw new Error('SOURCE_CONTROL_PLANE_MUTATION_FORBIDDEN');
  }
  if (changedPaths.some((path) => !task.writable_paths.includes(path))) {
    throw new Error('SOURCE_SCOPE_VIOLATION');
  }

  return { task, candidate, changed_paths: changedPaths };
}

function worktree(repo: string, revision: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-integrate-'));
  try {
    git(repo, ['worktree', 'add', '--detach', root, revision]);
  } catch (error: unknown) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    dispose: () => {
      gitStatus(repo, ['worktree', 'remove', '--force', root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function integrationMessage(
  claim: SourceClaimBinding,
  candidateSha: string,
  treeSha: string,
): string {
  return [
    `integrate source work ${claim.run_id}`,
    '',
    `Overcenter-Obligation-Key: ${claim.obligation_key}`,
    `Overcenter-Source-Candidate: ${candidateSha}`,
    `Overcenter-Verified-Tree: ${treeSha}`,
  ].join('\n');
}

function validExistingIntegration(
  repo: string,
  head: string,
  claim: SourceClaimBinding,
  candidateSha: string,
  verification: SourceVerification,
): string | null {
  if (verification.state !== 'verified' || !verification.tree_sha) return null;
  const commits = git(repo, ['rev-list', head]);
  for (const commit of commits.split('\n').filter(Boolean)) {
    const body = git(repo, ['show', '-s', '--format=%B', commit]);
    if (!body.includes(`Overcenter-Obligation-Key: ${claim.obligation_key}`)) continue;
    if (!body.includes(`Overcenter-Source-Candidate: ${candidateSha}`)) continue;
    if (!body.includes(`Overcenter-Verified-Tree: ${verification.tree_sha}`)) continue;

    const parents = git(repo, ['show', '-s', '--format=%P', commit]).split(/\s+/).filter(Boolean);
    if (parents.length !== 1 || parents[0] !== verification.base_sha) continue;
    const tree = git(repo, ['show', '-s', '--format=%T', commit]);
    if (tree !== verification.tree_sha) continue;
    return commit;
  }
  return null;
}

export function integrateVerifiedSourceCandidate(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  candidateSha: string,
  verificationValue: unknown,
  {
    remote = 'origin',
    ref = 'refs/heads/main',
  }: {
    remote?: string;
    ref?: string;
    performReservedMutation: (mutation: () => boolean) => boolean;
  },
): SourceIntegrationResult {
  try {
    inspectSourceCandidate(repo, taskValue, claim, candidateSha);
  } catch (error: unknown) {
    return {
      state: 'REJECTED',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let verification: SourceVerification;
  try {
    verification = validateSourceVerification(verificationValue);
  } catch (error: unknown) {
    return {
      state: 'REJECTED',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (verification.run_id !== claim.run_id) {
    return { state: 'REJECTED', reason: 'SOURCE_VERIFICATION_RUN_MISMATCH' };
  }
  if (verification.candidate_sha !== candidateSha) {
    return { state: 'REJECTED', reason: 'SOURCE_VERIFICATION_CANDIDATE_MISMATCH' };
  }
  if (verification.state !== 'verified' || !verification.tree_sha) {
    return {
      state: 'REREALIZE_REQUIRED',
      reason: verification.reason ?? 'SOURCE_VERIFICATION_REJECTED',
    };
  }

  let current: string;
  try {
    current = remoteRefHead(repo, remote, ref) ?? '';
  } catch {
    return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_AUTHORITY_UNREACHABLE' };
  }
  if (!current) return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_AUTHORITY_MISSING' };

  const replay = validExistingIntegration(repo, current, claim, candidateSha, verification);
  if (replay) {
    const evidence: SourceIntegrationEvidence = {
      schema: SOURCE_INTEGRATION_EVIDENCE_SCHEMA,
      run_id: claim.run_id,
      obligation_key: claim.obligation_key,
      source_sha: claim.source_sha,
      candidate_sha: candidateSha,
      verification_base_sha: verification.base_sha,
      verified_tree_sha: verification.tree_sha,
      integration_commit: replay,
      state: 'already-integrated',
    };
    return {
      state: 'ALREADY_INTEGRATED',
      witness: mintSourceIntegrationWitness(evidence),
      commit_sha: replay,
    };
  }

  if (current !== verification.base_sha) {
    return { state: 'REREALIZE_REQUIRED', reason: 'SOURCE_MAIN_MOVED_AFTER_VERIFICATION' };
  }

  const candidateTree = worktree(repo, current);
  let integrated = '';
  try {
    if (gitStatus(candidateTree.root, ['cherry-pick', '--no-commit', candidateSha]) !== 0) {
      return { state: 'REREALIZE_REQUIRED', reason: 'SOURCE_APPLY_CONFLICT' };
    }
    const tree = git(candidateTree.root, ['write-tree']);
    if (tree !== verification.tree_sha) {
      return { state: 'REJECTED', reason: 'SOURCE_VERIFICATION_TREE_MISMATCH' };
    }

    git(candidateTree.root, [
      '-c',
      'user.name=Overcenter Source Integrator',
      '-c',
      'user.email=overcenter@local',
      'commit',
      '-m',
      integrationMessage(claim, candidateSha, verification.tree_sha),
    ]);
    integrated = git(candidateTree.root, ['rev-parse', 'HEAD']);
  } finally {
    candidateTree.dispose();
  }

  let mutationReportedSuccess = false;
  try {
    mutationReportedSuccess = performReservedMutation(() =>
      remoteRefCas(repo, remote, ref, integrated, current),
    );
  } catch {
    return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_CAS_OUTCOME_UNCERTAIN' };
  }

  let observed: string;
  try {
    observed = remoteRefHead(repo, remote, ref) ?? '';
  } catch {
    return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_CAS_READBACK_UNAVAILABLE' };
  }
  if (observed === integrated) {
    const evidence: SourceIntegrationEvidence = {
      schema: SOURCE_INTEGRATION_EVIDENCE_SCHEMA,
      run_id: claim.run_id,
      obligation_key: claim.obligation_key,
      source_sha: claim.source_sha,
      candidate_sha: candidateSha,
      verification_base_sha: verification.base_sha,
      verified_tree_sha: verification.tree_sha,
      integration_commit: integrated,
      state: mutationReportedSuccess ? 'integrated' : 'already-integrated',
    };
    return {
      state: mutationReportedSuccess ? 'INTEGRATED' : 'ALREADY_INTEGRATED',
      witness: mintSourceIntegrationWitness(evidence),
      commit_sha: integrated,
    };
  }
  const after = observed
    ? validExistingIntegration(repo, observed, claim, candidateSha, verification)
    : null;
  if (after) {
    const evidence: SourceIntegrationEvidence = {
      schema: SOURCE_INTEGRATION_EVIDENCE_SCHEMA,
      run_id: claim.run_id,
      obligation_key: claim.obligation_key,
      source_sha: claim.source_sha,
      candidate_sha: candidateSha,
      verification_base_sha: verification.base_sha,
      verified_tree_sha: verification.tree_sha,
      integration_commit: after,
      state: 'already-integrated',
    };
    return {
      state: 'ALREADY_INTEGRATED',
      witness: mintSourceIntegrationWitness(evidence),
      commit_sha: after,
    };
  }
  return { state: 'RECOVERY_REQUIRED', reason: 'SOURCE_MAIN_CAS_NOT_CONFIRMED' };
}
