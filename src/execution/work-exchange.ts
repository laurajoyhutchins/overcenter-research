import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assignmentSha256,
  validateAssignment,
  validateCandidate,
  type Candidate,
} from './assignment-capsule.ts';
import { canonicalDigest, sha256 } from '../digest.ts';
import { isData, isPositiveSafeInteger, isSha256Hex } from '../validation.ts';

const PACKET_FILES = ['assignment.json', 'overcenter', 'receipt.json'] as const;
const PUBLICATION_SCHEMA = 'overcenter-candidate-publication' as const;
const PUBLICATION_SCHEMA_VERSION = 1 as const;
const CANDIDATE_PATH = '.overcenter/candidate.json' as const;

export interface CandidatePublicationPlan {
  schema: typeof PUBLICATION_SCHEMA;
  schema_version: typeof PUBLICATION_SCHEMA_VERSION;
  repository_full_name: string;
  run_id: string;
  parent_commit: string;
  branch: string;
  path: typeof CANDIDATE_PATH;
  candidate_sha256: string;
  candidate_git_blob_sha1: string;
  candidate_content_base64: string;
  commit_message: string;
}

export interface WorkExchangeResult {
  candidate: Candidate;
  candidate_path: string;
  publication_plan: CandidatePublicationPlan;
  publication_plan_path: string;
  worker_client_sha256: string;
  receipt_sha256: string;
}

interface AdvanceReceipt {
  schema: 'overcenter-project-advance/v1';
  command: 'project.advance';
  transport: 'github-actions-job-rerun';
  repository_id: number;
  repository_full_name: string;
  command_source_sha: string;
  command_run_id: number;
  command_run_attempt: number;
  authority_ref: string;
  authority_head: string;
  state: 'AGENT_EXECUTION_REQUIRED';
  obligation_id: string;
  run_id: string;
  claimed_revision: string;
  assignment_sha256: string;
  candidate_branch: string;
  candidate_branch_base_sha: string;
  receipt_digest: string;
}

export type WorkExchangeRun = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr?: string | Buffer | null;
};

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) fail(code);
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(code);
  }
}

function packetFile(root: string, name: (typeof PACKET_FILES)[number]): string {
  const path = join(root, name);
  if (!existsSync(path)) fail(`WORK_EXCHANGE_FILE_MISSING:${name}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`WORK_EXCHANGE_FILE_INVALID:${name}`);
  return path;
}

function validatePacketRoot(root: string): void {
  if (!existsSync(root)) fail('WORK_EXCHANGE_PACKET_ROOT_MISSING');
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('WORK_EXCHANGE_PACKET_ROOT_INVALID');
  const actual = readdirSync(root).sort();
  const expected = [...PACKET_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('WORK_EXCHANGE_PACKET_MEMBERSHIP_INVALID');
  }
}

function advanceReceipt(value: unknown): AdvanceReceipt {
  if (!isData(value)) fail('WORK_EXCHANGE_RECEIPT_INVALID');
  exactKeys(
    value,
    [
      'schema',
      'command',
      'transport',
      'repository_id',
      'repository_full_name',
      'command_source_sha',
      'command_run_id',
      'command_run_attempt',
      'authority_ref',
      'authority_head',
      'state',
      'obligation_id',
      'run_id',
      'claimed_revision',
      'assignment_sha256',
      'candidate_branch',
      'candidate_branch_base_sha',
      'receipt_digest',
    ],
    'WORK_EXCHANGE_RECEIPT_SHAPE_INVALID',
  );
  if (
    value.schema !== 'overcenter-project-advance/v1' ||
    value.command !== 'project.advance' ||
    value.transport !== 'github-actions-job-rerun' ||
    value.state !== 'AGENT_EXECUTION_REQUIRED'
  ) {
    fail('WORK_EXCHANGE_RECEIPT_KIND_INVALID');
  }
  if (
    !isPositiveSafeInteger(value.repository_id) ||
    !isPositiveSafeInteger(value.command_run_id) ||
    !isPositiveSafeInteger(value.command_run_attempt)
  ) {
    fail('WORK_EXCHANGE_RECEIPT_INTEGER_INVALID');
  }
  if (
    typeof value.repository_full_name !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/.test(value.repository_full_name)
  ) {
    fail('WORK_EXCHANGE_REPOSITORY_INVALID');
  }
  for (const field of [
    'command_source_sha',
    'authority_head',
    'candidate_branch_base_sha',
  ] as const) {
    if (typeof value[field] !== 'string' || !/^[0-9a-f]{40}$/.test(value[field])) {
      fail(`WORK_EXCHANGE_RECEIPT_SHA_INVALID:${field}`);
    }
  }
  for (const field of [
    'authority_ref',
    'obligation_id',
    'run_id',
    'claimed_revision',
    'candidate_branch',
  ] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      fail(`WORK_EXCHANGE_RECEIPT_STRING_INVALID:${field}`);
    }
  }
  if (!isSha256Hex(value.assignment_sha256) || !isSha256Hex(value.receipt_digest)) {
    fail('WORK_EXCHANGE_RECEIPT_DIGEST_INVALID');
  }

  const { receipt_digest: receiptDigest, ...unsigned } = value;
  if (canonicalDigest(unsigned) !== receiptDigest) fail('WORK_EXCHANGE_RECEIPT_DIGEST_MISMATCH');
  return value as unknown as AdvanceReceipt;
}

function bindReceipt(
  receipt: AdvanceReceipt,
  assignment: ReturnType<typeof validateAssignment>,
  assignmentDigest: string,
): void {
  if (
    receipt.obligation_id !== assignment.work.id ||
    receipt.run_id !== assignment.work.run_id ||
    receipt.claimed_revision !== assignment.work.claimed_revision ||
    receipt.assignment_sha256 !== assignmentDigest ||
    receipt.candidate_branch_base_sha !== assignment.source_revision ||
    receipt.candidate_branch !== `overcenter/candidate/${assignment.work.run_id}`
  ) {
    fail('WORK_EXCHANGE_RECEIPT_IDENTITY_MISMATCH');
  }
}

function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMP', 'TMPDIR', 'TEMP', 'USER']) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('LC_') && value !== undefined) env[name] = value;
  }
  return env;
}

function gitBlobSha1(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

export function candidatePublicationPlan(
  receipt: AdvanceReceipt,
  candidateBytes: Buffer,
): CandidatePublicationPlan {
  return {
    schema: PUBLICATION_SCHEMA,
    schema_version: PUBLICATION_SCHEMA_VERSION,
    repository_full_name: receipt.repository_full_name,
    run_id: receipt.run_id,
    parent_commit: receipt.candidate_branch_base_sha,
    branch: receipt.candidate_branch,
    path: CANDIDATE_PATH,
    candidate_sha256: sha256(candidateBytes),
    candidate_git_blob_sha1: gitBlobSha1(candidateBytes),
    candidate_content_base64: candidateBytes.toString('base64'),
    commit_message: `Submit Overcenter candidate ${receipt.run_id}`,
  };
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): ReturnType<WorkExchangeRun> {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
    stderr: result.stderr,
  };
}

function prepareOutputDirectory(path: string): string {
  const output = resolve(path);
  if (existsSync(output)) {
    const stat = lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('WORK_EXCHANGE_OUTPUT_INVALID');
    if (readdirSync(output).length !== 0) fail('WORK_EXCHANGE_OUTPUT_NOT_EMPTY');
  } else {
    mkdirSync(output, { recursive: true });
  }
  return output;
}

export function executeWorkPacket(
  packetRoot: string,
  outputDirectory: string,
  {
    run = defaultRun,
    processEnv = process.env,
  }: {
    run?: WorkExchangeRun;
    processEnv?: NodeJS.ProcessEnv;
  } = {},
): WorkExchangeResult {
  if (!isAbsolute(packetRoot)) fail('WORK_EXCHANGE_PACKET_ROOT_MUST_BE_ABSOLUTE');
  if (!isAbsolute(outputDirectory)) fail('WORK_EXCHANGE_OUTPUT_MUST_BE_ABSOLUTE');

  const root = resolve(packetRoot);
  validatePacketRoot(root);
  const output = prepareOutputDirectory(outputDirectory);

  const assignmentPath = packetFile(root, 'assignment.json');
  const workerPath = packetFile(root, 'overcenter');
  const receiptPath = packetFile(root, 'receipt.json');

  const assignmentBytes = readFileSync(assignmentPath);
  const assignment = validateAssignment(parseJson(assignmentBytes, 'WORK_EXCHANGE_ASSIGNMENT_JSON_INVALID'));
  const assignmentDigest = assignmentSha256(assignmentBytes);

  const receiptBytes = readFileSync(receiptPath);
  const receipt = advanceReceipt(parseJson(receiptBytes, 'WORK_EXCHANGE_RECEIPT_JSON_INVALID'));
  bindReceipt(receipt, assignment, assignmentDigest);

  chmodSync(workerPath, 0o755);
  try {
    accessSync(workerPath, constants.X_OK);
  } catch {
    fail('WORK_EXCHANGE_WORKER_NOT_EXECUTABLE');
  }

  const temp = mkdtempSync(join(tmpdir(), 'overcenter-work-exchange-'));
  try {
    const workspace = join(temp, 'workspace');
    const candidatePath = join(temp, 'candidate.json');
    mkdirSync(workspace);

    const outcome = run(workerPath, ['run', assignmentPath, workspace, candidatePath], {
      cwd: temp,
      env: workerEnvironment(processEnv),
    });
    if (outcome.error) throw outcome.error;
    if (outcome.status !== 0) {
      const detail = outcome.signal ?? outcome.status ?? 'unknown';
      fail(`WORK_EXCHANGE_WORKER_FAILED:${detail}`);
    }

    if (!existsSync(candidatePath)) fail('WORK_EXCHANGE_CANDIDATE_MISSING');
    const candidateStat = lstatSync(candidatePath);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
      fail('WORK_EXCHANGE_CANDIDATE_INVALID');
    }
    const candidateBytes = readFileSync(candidatePath);
    const candidate = validateCandidate(
      parseJson(candidateBytes, 'WORK_EXCHANGE_CANDIDATE_JSON_INVALID'),
      assignment,
      assignmentBytes,
    );

    const publishedCandidatePath = join(output, 'candidate.json');
    const planPath = join(output, 'publication-plan.json');
    writeFileSync(publishedCandidatePath, candidateBytes, { flag: 'wx' });

    const publicationPlan = candidatePublicationPlan(receipt, candidateBytes);
    writeFileSync(planPath, `${JSON.stringify(publicationPlan, null, 2)}\n`, { flag: 'wx' });

    return {
      candidate,
      candidate_path: publishedCandidatePath,
      publication_plan: publicationPlan,
      publication_plan_path: planPath,
      worker_client_sha256: sha256(readFileSync(workerPath)),
      receipt_sha256: sha256(receiptBytes),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, packetRoot, outputDirectory] = process.argv.slice(2);
  if (command !== 'execute' || !packetRoot || !outputDirectory || process.argv.length !== 5) {
    console.error('usage: work-exchange.ts execute <packet-directory> <output-directory>');
    process.exit(2);
  }
  const result = executeWorkPacket(resolve(packetRoot), resolve(outputDirectory));
  console.log(
    JSON.stringify(
      {
        run_id: result.candidate.run_id,
        candidate_path: result.candidate_path,
        publication_plan_path: result.publication_plan_path,
        candidate_sha256: result.publication_plan.candidate_sha256,
        candidate_git_blob_sha1: result.publication_plan.candidate_git_blob_sha1,
      },
      null,
      2,
    ),
  );
}
