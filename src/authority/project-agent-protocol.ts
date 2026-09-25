import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  AGENT_TASK_PACKET_SCHEMA,
  assignmentFile,
  assignmentSha256,
  buildAssignment,
  encodeAssignment,
  validateAgentTaskDefinition,
  validateAgentTaskPacket,
  validateCandidate,
  type AssignmentTaskPacket,
} from '../execution/assignment-capsule.ts';
import { canonicalDigest, sha256 } from '../digest.ts';
import { isSystemEvidenceWork } from '../evidence/system-evidence.ts';
import { isData, isPositiveSafeInteger } from '../validation.ts';
import { buildSourceAssignment, validateSourceTaskPacket } from '../source/source-obligation.ts';
import {
  integrateVerifiedSourceCandidate,
  validateSourceIntegrationEvidence,
  validateSourceVerification,
} from '../source/source-integration.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import { DEFAULT_PROJECT_GRAPH_PRODUCERS } from './default-project-graph.ts';
import {
  compileProjectGraph,
  managedProjectGraphPrefixes,
  type ProjectGraphProducer,
} from './project-graph.ts';
import { repositorySnapshot } from '../evidence/repository-snapshot.ts';
import type { ObservationContext } from '../observation/observe.ts';
import type { Work } from '../model.ts';

export const PROJECT_ADVANCE_RECEIPT_SCHEMA = 'overcenter-project-advance/v1' as const;
export const PROJECT_SUBMIT_RECEIPT_SCHEMA = 'overcenter-project-submit/v1' as const;
export const PROJECT_ADVANCE_COMMAND = 'project.advance' as const;
export const PROJECT_SUBMIT_COMMAND = 'project.submit' as const;

type ProjectVisibleState =
  | 'READY'
  | 'EXECUTING'
  | 'WAITING'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'DONE'
  | 'AGENT_EXECUTION_REQUIRED';

export interface ProjectCommandContext {
  repository_id: number;
  repository_full_name: string;
  command_source_sha: string;
  command_run_id: number;
  command_run_attempt: number;
}

export interface ProjectAdvanceReceipt {
  schema: typeof PROJECT_ADVANCE_RECEIPT_SCHEMA;
  command: typeof PROJECT_ADVANCE_COMMAND;
  transport: 'github-actions-job-rerun';
  repository_id: number;
  repository_full_name: string;
  command_source_sha: string;
  command_run_id: number;
  command_run_attempt: number;
  authority_ref: string;
  authority_head: string;
  state: ProjectVisibleState;
  obligation_id?: string;
  run_id?: string;
  claimed_revision?: string;
  assignment_sha256?: string;
  candidate_branch?: string;
  candidate_branch_base_sha?: string;
  receipt_digest: string;
}

export interface ProjectSubmitContext extends ProjectCommandContext {
  candidate_sha: string;
  candidate_run_id: string;
}

export interface ProjectSubmitReceipt {
  schema: typeof PROJECT_SUBMIT_RECEIPT_SCHEMA;
  command: typeof PROJECT_SUBMIT_COMMAND;
  transport: 'github-actions-job-rerun';
  repository_id: number;
  repository_full_name: string;
  command_source_sha: string;
  command_run_id: number;
  command_run_attempt: number;
  authority_ref: string;
  authority_head: string;
  candidate_sha: string;
  obligation_id: string;
  run_id: string;
  claimed_revision: string;
  assignment_sha256?: string;
  output_sha256?: string;
  integration_commit?: string;
  disposition: 'DONE' | 'READY' | 'RECOVERY_REQUIRED';
  verified: boolean;
  settlement_commit: string | null;
  already_settled: boolean;
  receipt_digest: string;
}

interface ProtocolOptions {
  authorityRef?: string;
  remote?: string;
  githubToken?: string | null;
}

interface AdvanceOptions extends ProtocolOptions {
  outputDir: string;
  workerClientPath?: string;
  graphProducers?: readonly ProjectGraphProducer[];
  observationContext?: ObservationContext;
}

interface SubmitOptions extends ProtocolOptions {
  candidatePath?: string;
  sourceVerificationPath?: string;
}

const DEFAULT_AUTHORITY_REF = 'refs/overcenter/state';
const DEFAULT_REMOTE = 'origin';
const DEFAULT_CANDIDATE_PATH = '.overcenter/candidate.json';

function positiveInteger(value: number, name: string): void {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`PROJECT_AGENT_INTEGER_INVALID:${name}`);
  }
}

function validateCommandContext(context: ProjectCommandContext): void {
  positiveInteger(context.repository_id, 'repository_id');
  positiveInteger(context.command_run_id, 'command_run_id');
  positiveInteger(context.command_run_attempt, 'command_run_attempt');
  if (context.command_run_attempt < 2) {
    throw new Error('PROJECT_AGENT_COMMAND_NOT_INVOKED');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(context.repository_full_name)) {
    throw new Error('PROJECT_AGENT_REPOSITORY_INVALID');
  }
  if (!/^[0-9a-f]{40}$/i.test(context.command_source_sha)) {
    throw new Error('PROJECT_AGENT_COMMAND_SOURCE_INVALID');
  }
}

function gitBytes(repo: string, commit: string, path: string): Buffer {
  return execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

interface GitTreeEntry {
  mode: '100644' | '100755' | '040000';
  type: 'blob' | 'tree';
  path: string;
}

function parseGitTree(raw: string): GitTreeEntry[] {
  return raw
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf('\t');
      if (tab < 0) throw new Error('PROJECT_ADVANCE_GIT_TREE_INVALID');
      const [mode, type] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (
        (mode !== '100644' && mode !== '100755' && mode !== '040000') ||
        (type !== 'blob' && type !== 'tree') ||
        path.length === 0
      ) {
        throw new Error('PROJECT_ADVANCE_GIT_TREE_UNSUPPORTED_ENTRY');
      }
      return { mode, type, path };
    });
}

function gitTreeEntries(repo: string, commit: string, path?: string): GitTreeEntry[] {
  const args = ['-C', repo, 'ls-tree', '-rz', '--full-tree', commit];
  if (path !== undefined) args.push('--', path);
  return parseGitTree(execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function gitSourceFile(
  repo: string,
  commit: string,
  path: string,
): ReturnType<typeof assignmentFile> {
  const entries = parseGitTree(
    execFileSync('git', ['-C', repo, 'ls-tree', '-z', commit, '--', path], {
      encoding: 'utf8',
    }),
  );
  if (entries.length !== 1 || entries[0]!.path !== path || entries[0]!.type !== 'blob') {
    throw new Error(`PROJECT_ADVANCE_REQUIRED_FILE_MISSING:${path}`);
  }
  const entry = entries[0]!;
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    throw new Error(`PROJECT_ADVANCE_REQUIRED_FILE_MODE_UNSUPPORTED:${path}`);
  }
  return assignmentFile(path, gitBytes(repo, commit, path), entry.mode);
}

function gitSourceTree(
  repo: string,
  commit: string,
  treePath: string,
): ReturnType<typeof assignmentFile>[] {
  if (treePath !== '.') {
    const root = parseGitTree(
      execFileSync('git', ['-C', repo, 'ls-tree', '-z', commit, '--', treePath], {
        encoding: 'utf8',
      }),
    );
    if (
      root.length !== 1 ||
      root[0]!.path !== treePath ||
      root[0]!.type !== 'tree' ||
      root[0]!.mode !== '040000'
    ) {
      throw new Error(`PROJECT_ADVANCE_REQUIRED_TREE_MISSING:${treePath}`);
    }
  }

  const entries = gitTreeEntries(repo, commit, treePath === '.' ? undefined : treePath);
  if (entries.length === 0) {
    throw new Error(`PROJECT_ADVANCE_REQUIRED_TREE_EMPTY:${treePath}`);
  }
  return entries.map((entry) => {
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      throw new Error(`PROJECT_ADVANCE_REQUIRED_TREE_ENTRY_UNSUPPORTED:${entry.path}`);
    }
    return assignmentFile(entry.path, gitBytes(repo, commit, entry.path), entry.mode);
  });
}

function prepareAgentPacket(
  repo: string,
  work: Work,
  sourceRevision: string,
): {
  sourceRevision: string;
  files: ReturnType<typeof assignmentFile>[];
  packet: AssignmentTaskPacket;
} {
  if (work.packet.schema !== AGENT_TASK_PACKET_SCHEMA || work.packet.kind !== 'pure-candidate') {
    throw new Error('PROJECT_ADVANCE_AGENT_PACKET_UNSUPPORTED');
  }
  const definition = validateAgentTaskDefinition(work.packet);

  const source = sourceRevision.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(source)) {
    throw new Error('PROJECT_ADVANCE_SOURCE_REVISION_INVALID');
  }

  const byPath = new Map<string, ReturnType<typeof assignmentFile>>();
  for (const path of definition.required_paths) {
    byPath.set(path, gitSourceFile(repo, source, path));
  }
  for (const tree of definition.required_trees ?? []) {
    for (const file of gitSourceTree(repo, source, tree)) {
      byPath.set(file.path, file);
    }
  }
  const files = [...byPath.values()];
  if (files.length === 0) throw new Error('PROJECT_ADVANCE_SOURCE_INPUTS_EMPTY');

  const packet = validateAgentTaskPacket({
    schema: AGENT_TASK_PACKET_SCHEMA,
    kind: 'pure-candidate',
    command: definition.command,
    required_paths: files.map((file) => file.path),
    output_path: definition.output_path,
  });

  return {
    sourceRevision: source,
    files,
    packet,
  };
}

function agentAssignment(
  work: Work,
  prepared: {
    sourceRevision: string;
    files: ReturnType<typeof assignmentFile>[];
    packet: AssignmentTaskPacket;
  },
): {
  bytes: Buffer;
  source_sha: string;
} {
  const assignment = buildAssignment(
    { ...structuredClone(work), packet: structuredClone(prepared.packet) },
    prepared.files,
    prepared.sourceRevision,
  );
  const bytes = encodeAssignment(assignment);
  if (bytes.includes(Buffer.from('execution_capability'))) {
    throw new Error('PROJECT_ADVANCE_PACKET_LEAKED_EXECUTION_CAPABILITY');
  }
  return { bytes, source_sha: prepared.sourceRevision };
}

function visibleState(work: Work[]): ProjectVisibleState {
  if (work.length === 0 || work.every((candidate) => candidate.status === 'DONE')) {
    return 'DONE';
  }
  for (const status of ['RECOVERY_REQUIRED', 'EXECUTING', 'WAITING', 'BLOCKED', 'READY'] as const) {
    if (work.some((candidate) => candidate.status === status)) return status;
  }
  throw new Error('PROJECT_ADVANCE_STATE_UNCLASSIFIED');
}

function withDigest<T extends Record<string, unknown>>(base: T): T & { receipt_digest: string } {
  return {
    ...base,
    receipt_digest: canonicalDigest(base),
  };
}

export function advanceProjectForAgent(
  repo: string,
  context: ProjectCommandContext,
  {
    outputDir,
    workerClientPath,
    authorityRef = DEFAULT_AUTHORITY_REF,
    remote = DEFAULT_REMOTE,
    githubToken = null,
    graphProducers = DEFAULT_PROJECT_GRAPH_PRODUCERS,
    observationContext = { githubToken },
  }: AdvanceOptions,
): ProjectAdvanceReceipt {
  validateCommandContext(context);
  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
    observationContext,
  });
  if (!kernel.head()) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
  const snapshot = repositorySnapshot(repo, context.command_source_sha.toLowerCase());
  const desired = compileProjectGraph(snapshot, context, graphProducers);
  const managedPrefixes = managedProjectGraphPrefixes(snapshot, graphProducers);

  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (desired.length > 0 || managedPrefixes.length > 0) {
      const expectedRevision = kernel.head();
      if (!expectedRevision) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
      try {
        kernel.reconcileGraph(desired, expectedRevision, {
          retireMissingPrefixes: managedPrefixes,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'STALE_REVISION') continue;
        throw error;
      }
    }

    const ready = kernel.deriveReadyWork();
    if (!ready) {
      const authorityHead = kernel.head();
      if (!authorityHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
      return withDigest({
        schema: PROJECT_ADVANCE_RECEIPT_SCHEMA,
        command: PROJECT_ADVANCE_COMMAND,
        transport: 'github-actions-job-rerun' as const,
        repository_id: context.repository_id,
        repository_full_name: context.repository_full_name,
        command_source_sha: context.command_source_sha.toLowerCase(),
        command_run_id: context.command_run_id,
        command_run_attempt: context.command_run_attempt,
        authority_ref: authorityRef,
        authority_head: authorityHead,
        state: visibleState(kernel.inspect()),
      });
    }

    if (isSystemEvidenceWork(ready)) {
      const authorityHead = kernel.head();
      if (!authorityHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
      return withDigest({
        schema: PROJECT_ADVANCE_RECEIPT_SCHEMA,
        command: PROJECT_ADVANCE_COMMAND,
        transport: 'github-actions-job-rerun' as const,
        repository_id: context.repository_id,
        repository_full_name: context.repository_full_name,
        command_source_sha: context.command_source_sha.toLowerCase(),
        command_run_id: context.command_run_id,
        command_run_attempt: context.command_run_attempt,
        authority_ref: authorityRef,
        authority_head: authorityHead,
        state: 'READY' as const,
        obligation_id: ready.id,
      });
    }

    // Frontier choice remains deterministic. The packet kind selects only the
    // realization transport, never a different obligation identity.
    const sourceRevision = context.command_source_sha.toLowerCase();
    let preparedAgent: ReturnType<typeof prepareAgentPacket> | null = null;
    let workerClient: Buffer | null = null;
    if (
      ready.packet.schema === AGENT_TASK_PACKET_SCHEMA &&
      ready.packet.kind === 'pure-candidate'
    ) {
      preparedAgent = prepareAgentPacket(repo, ready, sourceRevision);
      if (!workerClientPath) throw new Error('PROJECT_ADVANCE_WORKER_CLIENT_REQUIRED');
      workerClient = readFileSync(workerClientPath);
      if (workerClient.length === 0) throw new Error('PROJECT_ADVANCE_WORKER_CLIENT_EMPTY');
    } else if (ready.packet.kind === 'source-change') {
      validateSourceTaskPacket(ready.packet);
      if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
        throw new Error('PROJECT_ADVANCE_SOURCE_REVISION_INVALID');
      }
    } else {
      throw new Error('PROJECT_ADVANCE_AGENT_PACKET_UNSUPPORTED');
    }

    try {
      const permit = kernel.claim(ready.id, ready.revision, { sourceRevision });
      const claimed = kernel.claimedWork(permit.id);
      let assignmentBytes: Buffer;
      if (claimed.packet.kind === 'source-change') {
        const sourceAssignment = buildSourceAssignment(
          claimed.id,
          claimed.packet,
          kernel.sourceClaimBinding(permit.id),
        );
        assignmentBytes = Buffer.from(`${JSON.stringify(sourceAssignment, null, 2)}\n`, 'utf8');
      } else {
        if (!preparedAgent) throw new Error('PROJECT_ADVANCE_AGENT_PACKET_UNSUPPORTED');
        assignmentBytes = agentAssignment(claimed, preparedAgent).bytes;
      }
      if (assignmentBytes.includes(Buffer.from('execution_capability'))) {
        throw new Error('PROJECT_ADVANCE_PACKET_LEAKED_EXECUTION_CAPABILITY');
      }

      const authorityHead = kernel.head();
      if (!authorityHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');

      rmSync(outputDir, { recursive: true, force: true });
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'assignment.json'), assignmentBytes);
      if (workerClient) writeFileSync(join(outputDir, 'overcenter'), workerClient, { mode: 0o755 });

      const base = {
        schema: PROJECT_ADVANCE_RECEIPT_SCHEMA,
        command: PROJECT_ADVANCE_COMMAND,
        transport: 'github-actions-job-rerun' as const,
        repository_id: context.repository_id,
        repository_full_name: context.repository_full_name,
        command_source_sha: sourceRevision,
        command_run_id: context.command_run_id,
        command_run_attempt: context.command_run_attempt,
        authority_ref: authorityRef,
        authority_head: authorityHead,
        state: 'AGENT_EXECUTION_REQUIRED' as const,
        obligation_id: claimed.id,
        run_id: permit.id,
        claimed_revision: permit.claimed_revision,
        assignment_sha256: assignmentSha256(assignmentBytes),
        candidate_branch: `overcenter/candidate/${permit.id}`,
        candidate_branch_base_sha: permit.source_revision ?? sourceRevision,
      };
      const receipt = withDigest(base);
      writeFileSync(join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'STALE_REVISION' || message === 'CLAIM_LOST') continue;
      throw error;
    }
  }
  throw new Error('PROJECT_ADVANCE_CONTENTION_EXHAUSTED');
}

function safeLocalObservationRoot(path: string): string {
  const target = resolve(path);
  const root = dirname(target);
  if (root === '/tmp' || dirname(root) !== '/tmp') {
    throw new Error('PROJECT_SUBMIT_LOCAL_POSTCONDITION_UNSAFE');
  }
  return root;
}

function assertNonEmptyCandidateRun(value: string): void {
  if (!value) throw new Error('PROJECT_SUBMIT_CANDIDATE_RUN_REQUIRED');
}

function sourceSubmitReceipt(
  context: ProjectSubmitContext,
  authorityRef: string,
  kernel: GitOvercenterKernel,
  obligationId: string,
  claimedRevision: string,
  candidateSha: string,
  settled: ReturnType<GitOvercenterKernel['recoverInterrupted']>,
  alreadySettled: boolean,
  integrationCommit?: string,
): ProjectSubmitReceipt {
  if (settled.disposition === 'WAITING') {
    throw new Error('PROJECT_SUBMIT_SOURCE_SETTLEMENT_WAITING');
  }
  const authorityHead = kernel.head();
  if (!authorityHead) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');
  return withDigest({
    schema: PROJECT_SUBMIT_RECEIPT_SCHEMA,
    command: PROJECT_SUBMIT_COMMAND,
    transport: 'github-actions-job-rerun' as const,
    repository_id: context.repository_id,
    repository_full_name: context.repository_full_name,
    command_source_sha: context.command_source_sha.toLowerCase(),
    command_run_id: context.command_run_id,
    command_run_attempt: context.command_run_attempt,
    authority_ref: authorityRef,
    authority_head: authorityHead,
    candidate_sha: candidateSha,
    obligation_id: obligationId,
    run_id: context.candidate_run_id,
    claimed_revision: claimedRevision,
    ...(integrationCommit ? { integration_commit: integrationCommit } : {}),
    disposition: settled.disposition,
    verified: settled.verified,
    settlement_commit: settled.settlement_commit ?? null,
    already_settled: alreadySettled,
  });
}

export function submitProjectCandidate(
  repo: string,
  context: ProjectSubmitContext,
  {
    authorityRef = DEFAULT_AUTHORITY_REF,
    remote = DEFAULT_REMOTE,
    githubToken = null,
    candidatePath = DEFAULT_CANDIDATE_PATH,
    sourceVerificationPath,
  }: SubmitOptions = {},
): ProjectSubmitReceipt {
  validateCommandContext(context);
  assertNonEmptyCandidateRun(context.candidate_run_id);
  const candidateSha = context.candidate_sha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error('PROJECT_SUBMIT_CANDIDATE_SHA_INVALID');
  }

  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
  });
  if (!kernel.head()) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');

  const runId = context.candidate_run_id;
  const assigned = kernel.claimedWork(runId);
  const sourceRevision = kernel.claimedSourceRevision(runId);
  if (!sourceRevision) throw new Error('PROJECT_SUBMIT_SOURCE_REVISION_MISSING');

  if (assigned.packet.kind === 'source-change') {
    const claim = kernel.sourceClaimBinding(runId);
    const prior = kernel.receipts(runId).at(-1);
    if (prior?.disposition === 'DONE' && prior.kind === 'source-integration') {
      const diagnostic = isData(prior.diagnostic) ? prior.diagnostic.source_integration : null;
      const evidence = validateSourceIntegrationEvidence(diagnostic);
      if (evidence.candidate_sha !== candidateSha) {
        throw new Error('PROJECT_SUBMIT_SETTLED_SOURCE_MISMATCH');
      }
      const authorityHead = kernel.head();
      if (!authorityHead) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');
      return withDigest({
        schema: PROJECT_SUBMIT_RECEIPT_SCHEMA,
        command: PROJECT_SUBMIT_COMMAND,
        transport: 'github-actions-job-rerun' as const,
        repository_id: context.repository_id,
        repository_full_name: context.repository_full_name,
        command_source_sha: context.command_source_sha.toLowerCase(),
        command_run_id: context.command_run_id,
        command_run_attempt: context.command_run_attempt,
        authority_ref: authorityRef,
        authority_head: authorityHead,
        candidate_sha: candidateSha,
        obligation_id: assigned.id,
        run_id: runId,
        claimed_revision: claim.claimed_revision,
        integration_commit: evidence.integration_commit,
        disposition: 'DONE' as const,
        verified: true,
        settlement_commit: prior.settlement_commit ?? null,
        already_settled: true,
      });
    }
    if (prior?.disposition === 'READY' && prior.kind === 'source-retry') {
      const authorityHead = kernel.head();
      if (!authorityHead) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');
      return withDigest({
        schema: PROJECT_SUBMIT_RECEIPT_SCHEMA,
        command: PROJECT_SUBMIT_COMMAND,
        transport: 'github-actions-job-rerun' as const,
        repository_id: context.repository_id,
        repository_full_name: context.repository_full_name,
        command_source_sha: context.command_source_sha.toLowerCase(),
        command_run_id: context.command_run_id,
        command_run_attempt: context.command_run_attempt,
        authority_ref: authorityRef,
        authority_head: authorityHead,
        candidate_sha: candidateSha,
        obligation_id: assigned.id,
        run_id: runId,
        claimed_revision: claim.claimed_revision,
        disposition: 'READY' as const,
        verified: false,
        settlement_commit: prior.settlement_commit ?? null,
        already_settled: true,
      });
    }

    const current = kernel.inspect().find((work) => work.id === assigned.id);
    if (!current || current.run_id !== runId) {
      throw new Error('PROJECT_SUBMIT_AUTHORITY_RUN_MISMATCH');
    }
    if (!['EXECUTING', 'RECOVERY_REQUIRED'].includes(current.status)) {
      throw new Error(`PROJECT_SUBMIT_RUN_NOT_SETTLEABLE:${current.status}`);
    }

    const permit = kernel.acquireExecution(runId);
    if (!sourceVerificationPath) {
      const recovered = kernel.recoverInterrupted(permit, {
        source_verification: { reason: 'SOURCE_VERIFICATION_MISSING', candidate_sha: candidateSha },
      });
      return sourceSubmitReceipt(
        context,
        authorityRef,
        kernel,
        assigned.id,
        claim.claimed_revision,
        candidateSha,
        recovered,
        false,
      );
    }

    let verification: ReturnType<typeof validateSourceVerification>;
    try {
      verification = validateSourceVerification(
        JSON.parse(readFileSync(sourceVerificationPath, 'utf8')),
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const recovered = kernel.recoverInterrupted(permit, {
        source_verification: { reason, candidate_sha: candidateSha },
      });
      return sourceSubmitReceipt(
        context,
        authorityRef,
        kernel,
        assigned.id,
        claim.claimed_revision,
        candidateSha,
        recovered,
        false,
      );
    }

    const integration = integrateVerifiedSourceCandidate(
      repo,
      assigned.packet,
      claim,
      candidateSha,
      verification,
      { remote },
    );

    if (integration.state === 'INTEGRATED' || integration.state === 'ALREADY_INTEGRATED') {
      const settled = kernel.settleSourceIntegration(permit, integration.witness);
      return sourceSubmitReceipt(
        context,
        authorityRef,
        kernel,
        assigned.id,
        claim.claimed_revision,
        candidateSha,
        settled,
        integration.state === 'ALREADY_INTEGRATED',
        integration.commit_sha,
      );
    }

    if (integration.state === 'RECOVERY_REQUIRED') {
      const recovered = kernel.recoverInterrupted(permit, {
        source_integration: { reason: integration.reason, candidate_sha: candidateSha },
      });
      return sourceSubmitReceipt(
        context,
        authorityRef,
        kernel,
        assigned.id,
        claim.claimed_revision,
        candidateSha,
        recovered,
        false,
      );
    }

    if (integration.state === 'REJECTED' || integration.state === 'REREALIZE_REQUIRED') {
      const retry = kernel.retrySourceIntegration(permit, integration.reason, {
        candidate_sha: candidateSha,
      });
      return sourceSubmitReceipt(
        context,
        authorityRef,
        kernel,
        assigned.id,
        claim.claimed_revision,
        candidateSha,
        retry,
        false,
      );
    }
    throw new Error('SOURCE_INTEGRATION_RESULT_UNCLASSIFIED');
  }

  const raw = JSON.parse(gitBytes(repo, candidateSha, candidatePath).toString('utf8'));
  if (!isData(raw) || raw.run_id !== runId) {
    throw new Error('PROJECT_SUBMIT_CANDIDATE_RUN_INVALID');
  }
  const rebuilt = agentAssignment(assigned, prepareAgentPacket(repo, assigned, sourceRevision));
  const candidate = validateCandidate(
    raw,
    JSON.parse(rebuilt.bytes.toString('utf8')),
    rebuilt.bytes,
  );

  const priorDone = kernel
    .receipts(candidate.run_id)
    .filter((receipt) => receipt.disposition === 'DONE' && receipt.verified)
    .at(-1);
  if (priorDone) {
    const diagnostic =
      isData(priorDone.diagnostic) && isData(priorDone.diagnostic.agent_candidate)
        ? priorDone.diagnostic.agent_candidate
        : null;
    if (
      !diagnostic ||
      diagnostic.assignment_sha256 !== candidate.assignment_sha256 ||
      diagnostic.output_sha256 !== candidate.output_sha256
    ) {
      throw new Error('PROJECT_SUBMIT_SETTLED_OUTPUT_MISMATCH');
    }
    const authorityHead = kernel.head();
    if (!authorityHead) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');
    return withDigest({
      schema: PROJECT_SUBMIT_RECEIPT_SCHEMA,
      command: PROJECT_SUBMIT_COMMAND,
      transport: 'github-actions-job-rerun' as const,
      repository_id: context.repository_id,
      repository_full_name: context.repository_full_name,
      command_source_sha: context.command_source_sha.toLowerCase(),
      command_run_id: context.command_run_id,
      command_run_attempt: context.command_run_attempt,
      authority_ref: authorityRef,
      authority_head: authorityHead,
      candidate_sha: candidateSha,
      obligation_id: assigned.id,
      run_id: candidate.run_id,
      claimed_revision: candidate.claimed_revision,
      assignment_sha256: candidate.assignment_sha256,
      output_sha256: candidate.output_sha256,
      disposition: 'DONE' as const,
      verified: true,
      settlement_commit: priorDone.settlement_commit ?? null,
      already_settled: true,
    });
  }

  const current = kernel.inspect().find((work) => work.id === assigned.id);
  if (!current || current.run_id !== candidate.run_id) {
    throw new Error('PROJECT_SUBMIT_AUTHORITY_RUN_MISMATCH');
  }
  if (!['EXECUTING', 'RECOVERY_REQUIRED'].includes(current.status)) {
    throw new Error(`PROJECT_SUBMIT_RUN_NOT_SETTLEABLE:${current.status}`);
  }

  const postcondition = assigned.postcondition;
  if (
    postcondition.verifier !== 'file-content-equals/v1' ||
    typeof postcondition.path !== 'string' ||
    typeof postcondition.content !== 'string'
  ) {
    throw new Error('PROJECT_SUBMIT_POSTCONDITION_UNSUPPORTED');
  }

  const root = safeLocalObservationRoot(postcondition.path);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const output = Buffer.from(candidate.output_base64, 'base64');
  if (sha256(output) !== candidate.output_sha256) {
    throw new Error('PROJECT_SUBMIT_OUTPUT_DIGEST_MISMATCH');
  }
  writeFileSync(postcondition.path, output, { flag: 'wx' });

  const settlementKernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
    observationContext: { localFileRoot: root },
  });
  const before = settlementKernel.inspect().find((work) => work.id === assigned.id);
  if (!before || before.run_id !== candidate.run_id) {
    throw new Error('PROJECT_SUBMIT_AUTHORITY_RUN_MISMATCH');
  }

  const permit = settlementKernel.acquireExecution(candidate.run_id);
  const settled = settlementKernel.resolve(permit, {
    agent_candidate: {
      assignment_sha256: candidate.assignment_sha256,
      output_sha256: candidate.output_sha256,
      candidate_sha: candidateSha,
    },
  });
  if (settled.disposition !== 'DONE' || settled.verified !== true) {
    throw new Error(`PROJECT_SUBMIT_CANDIDATE_NOT_VERIFIED:${settled.disposition}`);
  }

  const authorityHead = settlementKernel.head();
  if (!authorityHead) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');
  return withDigest({
    schema: PROJECT_SUBMIT_RECEIPT_SCHEMA,
    command: PROJECT_SUBMIT_COMMAND,
    transport: 'github-actions-job-rerun' as const,
    repository_id: context.repository_id,
    repository_full_name: context.repository_full_name,
    command_source_sha: context.command_source_sha.toLowerCase(),
    command_run_id: context.command_run_id,
    command_run_attempt: context.command_run_attempt,
    authority_ref: authorityRef,
    authority_head: authorityHead,
    candidate_sha: candidateSha,
    obligation_id: assigned.id,
    run_id: candidate.run_id,
    claimed_revision: candidate.claimed_revision,
    assignment_sha256: candidate.assignment_sha256,
    output_sha256: candidate.output_sha256,
    disposition: 'DONE' as const,
    verified: true,
    settlement_commit: settled.settlement_commit ?? null,
    already_settled: false,
  });
}
