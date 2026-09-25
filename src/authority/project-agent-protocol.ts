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
import {
  compileHostileMutationEvidenceObligation,
  HOSTILE_MUTATION_EVIDENCE_PATH,
  HOSTILE_MUTATION_PROBES_PATH,
  isSystemEvidenceObligation,
} from '../evidence/hostile-mutation-obligation.ts';
import { isData, isPositiveSafeInteger } from '../validation.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import { compileProjectIntent, PROJECT_INTENT_PATH } from './project-intent.ts';
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
  assignment_sha256: string;
  output_sha256: string;
  disposition: 'DONE';
  verified: true;
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
}

interface SubmitOptions extends ProtocolOptions {
  candidatePath?: string;
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

function gitOptionalBytes(repo: string, commit: string, path: string): Buffer | null {
  const listed = execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', commit, '--', path], {
    encoding: 'utf8',
  }).trim();
  if (listed === '') return null;
  if (listed !== path) throw new Error('PROJECT_INTENT_PATH_AMBIGUOUS');
  return gitBytes(repo, commit, path);
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

function desiredProjectGraph(repo: string, sourceSha: string, context: ProjectCommandContext) {
  const bytes = gitOptionalBytes(repo, sourceSha, PROJECT_INTENT_PATH);
  let intent: ReturnType<typeof compileProjectIntent> = [];
  if (bytes) {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('PROJECT_INTENT_JSON_INVALID');
    }
    intent = compileProjectIntent(value);
  }
  const mutationProbes = gitOptionalBytes(repo, sourceSha, HOSTILE_MUTATION_PROBES_PATH);
  const mutationEvidence = gitOptionalBytes(repo, sourceSha, HOSTILE_MUTATION_EVIDENCE_PATH);
  if ((mutationProbes === null) !== (mutationEvidence === null)) {
    throw new Error('HOSTILE_MUTATION_EVIDENCE_INPUT_INCOMPLETE');
  }
  return [
    ...intent,
    ...(mutationProbes && mutationEvidence
      ? [
          compileHostileMutationEvidenceObligation({
            repo,
            sourceSha,
            repositoryId: context.repository_id,
            repositoryFullName: context.repository_full_name,
          }),
        ]
      : []),
  ];
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
  }: AdvanceOptions,
): ProjectAdvanceReceipt {
  validateCommandContext(context);
  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
  });
  if (!kernel.head()) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
  const desired = desiredProjectGraph(repo, context.command_source_sha.toLowerCase(), context);

  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (desired) {
      const expectedRevision = kernel.head();
      if (!expectedRevision) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');
      try {
        kernel.reconcileGraph(desired, expectedRevision);
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

    if (isSystemEvidenceObligation(ready)) {
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

    // The operator command does not ask the reasoning agent to choose work.
    // It only accepts a frontier item that is already an agent-shaped packet.
    const prepared = prepareAgentPacket(repo, ready, context.command_source_sha.toLowerCase());
    if (!workerClientPath) {
      throw new Error('PROJECT_ADVANCE_WORKER_CLIENT_REQUIRED');
    }
    const workerClient = readFileSync(workerClientPath);
    if (workerClient.length === 0) {
      throw new Error('PROJECT_ADVANCE_WORKER_CLIENT_EMPTY');
    }

    try {
      const permit = kernel.claim(ready.id, ready.revision, {
        sourceRevision: prepared.sourceRevision,
      });
      const claimed = kernel.claimedWork(permit.id);
      const assignment = agentAssignment(claimed, prepared);
      const authorityHead = kernel.head();
      if (!authorityHead) throw new Error('PROJECT_ADVANCE_AUTHORITY_MISSING');

      rmSync(outputDir, { recursive: true, force: true });
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'assignment.json'), assignment.bytes);
      writeFileSync(join(outputDir, 'overcenter'), workerClient, { mode: 0o755 });

      const base = {
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
        state: 'AGENT_EXECUTION_REQUIRED' as const,
        obligation_id: claimed.id,
        run_id: permit.id,
        claimed_revision: permit.claimed_revision,
        assignment_sha256: assignmentSha256(assignment.bytes),
        candidate_branch: `overcenter/candidate/${permit.id}`,
        candidate_branch_base_sha: permit.source_revision ?? prepared.sourceRevision,
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

export function submitProjectCandidate(
  repo: string,
  context: ProjectSubmitContext,
  {
    authorityRef = DEFAULT_AUTHORITY_REF,
    remote = DEFAULT_REMOTE,
    githubToken = null,
    candidatePath = DEFAULT_CANDIDATE_PATH,
  }: SubmitOptions = {},
): ProjectSubmitReceipt {
  validateCommandContext(context);
  const candidateSha = context.candidate_sha.toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error('PROJECT_SUBMIT_CANDIDATE_SHA_INVALID');
  }

  const raw = JSON.parse(gitBytes(repo, candidateSha, candidatePath).toString('utf8'));
  if (!isData(raw) || typeof raw.run_id !== 'string') {
    throw new Error('PROJECT_SUBMIT_CANDIDATE_RUN_INVALID');
  }

  const kernel = new GitOvercenterKernel(repo, {
    ref: authorityRef,
    remote,
    githubToken,
  });
  if (!kernel.head()) throw new Error('PROJECT_SUBMIT_AUTHORITY_MISSING');

  const assigned = kernel.claimedWork(raw.run_id);
  const sourceRevision = kernel.claimedSourceRevision(raw.run_id);
  if (!sourceRevision) throw new Error('PROJECT_SUBMIT_SOURCE_REVISION_MISSING');
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
      verified: true as const,
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
    verified: true as const,
    settlement_commit: settled.settlement_commit ?? null,
    already_settled: false,
  });
}
