import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assignmentSha256,
  validateAssignment,
  validateCandidate,
  type Candidate,
} from '../assignment-capsule.ts';
import { sha256 } from '../../digest.ts';
import { isData } from '../../validation.ts';
import {
  assertNoProviderCredentials,
  minimalExecutionEnvironment,
} from './environment.ts';

const TRANSPORT_SCHEMA = 'overcenter-work-packet-transport/v1' as const;
const PACKET_FILES = ['assignment.json', 'overcenter', 'receipt.json'] as const;

export interface WorkPacketTransportRequest {
  schema: typeof TRANSPORT_SCHEMA;
  obligation_id: string;
  run_id: string;
  source_revision: string;
  assignment_path: string;
  assignment_sha256: string;
  worker_client_path: string;
  worker_client_sha256: string;
  receipt_path: string;
  receipt_sha256: string;
}

export type WorkPacketTransportSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

async function spawnTransport(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

function packetFile(packetRoot: string, name: (typeof PACKET_FILES)[number]): string {
  const path = join(packetRoot, name);
  if (!existsSync(path)) throw new Error(`WORK_PACKET_TRANSPORT_FILE_MISSING:${name}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`WORK_PACKET_TRANSPORT_FILE_INVALID:${name}`);
  }
  return path;
}

function validatePacketMembership(packetRoot: string): void {
  const stat = lstatSync(packetRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('WORK_PACKET_TRANSPORT_PACKET_ROOT_INVALID');
  }
  const actual = readdirSync(packetRoot).sort();
  const expected = [...PACKET_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('WORK_PACKET_TRANSPORT_PACKET_MEMBERSHIP_INVALID');
  }
}

function transportExecutable(path: string): string {
  if (!isAbsolute(path)) throw new Error('WORK_PACKET_TRANSPORT_EXECUTABLE_MUST_BE_ABSOLUTE');
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error('WORK_PACKET_TRANSPORT_EXECUTABLE_MISSING');
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('WORK_PACKET_TRANSPORT_EXECUTABLE_INVALID');
  }
  return absolute;
}

function receiptIdentity(
  value: unknown,
  assignment: ReturnType<typeof validateAssignment>,
  assignmentDigest: string,
): void {
  if (
    !isData(value) ||
    value.state !== 'AGENT_EXECUTION_REQUIRED' ||
    value.obligation_id !== assignment.work.id ||
    value.run_id !== assignment.work.run_id ||
    value.claimed_revision !== assignment.work.claimed_revision ||
    value.assignment_sha256 !== assignmentDigest
  ) {
    throw new Error('WORK_PACKET_TRANSPORT_RECEIPT_IDENTITY_MISMATCH');
  }
}

export async function executeWorkPacketTransport(
  {
    packetRoot,
    transport,
    candidateOutputPath,
  }: {
    packetRoot: string;
    transport: string;
    candidateOutputPath: string;
  },
  {
    spawnProcess = spawnTransport,
    processEnv = process.env,
    extraEnv = {},
  }: {
    spawnProcess?: WorkPacketTransportSpawn;
    processEnv?: NodeJS.ProcessEnv;
    extraEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<Candidate> {
  if (!isAbsolute(packetRoot)) throw new Error('WORK_PACKET_TRANSPORT_ROOT_MUST_BE_ABSOLUTE');
  if (!isAbsolute(candidateOutputPath)) {
    throw new Error('WORK_PACKET_TRANSPORT_CANDIDATE_MUST_BE_ABSOLUTE');
  }
  const root = resolve(packetRoot);
  validatePacketMembership(root);

  const assignmentPath = packetFile(root, 'assignment.json');
  const clientPath = packetFile(root, 'overcenter');
  const receiptPath = packetFile(root, 'receipt.json');
  const assignmentBytes = readFileSync(assignmentPath);
  const assignment = validateAssignment(JSON.parse(assignmentBytes.toString('utf8')));
  const assignmentDigest = assignmentSha256(assignmentBytes);
  const receiptBytes = readFileSync(receiptPath);
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new Error('WORK_PACKET_TRANSPORT_RECEIPT_JSON_INVALID');
  }
  receiptIdentity(receipt, assignment, assignmentDigest);

  const executable = transportExecutable(transport);
  const temp = mkdtempSync(join(tmpdir(), 'overcenter-work-packet-transport-'));
  try {
    const requestPath = join(temp, 'request.json');
    const candidatePath = join(temp, 'candidate.json');
    const request: WorkPacketTransportRequest = {
      schema: TRANSPORT_SCHEMA,
      obligation_id: assignment.work.id,
      run_id: assignment.work.run_id,
      source_revision: assignment.source_revision,
      assignment_path: assignmentPath,
      assignment_sha256: assignmentDigest,
      worker_client_path: clientPath,
      worker_client_sha256: sha256(readFileSync(clientPath)),
      receipt_path: receiptPath,
      receipt_sha256: sha256(receiptBytes),
    };
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' });

    const env = {
      ...minimalExecutionEnvironment(processEnv),
      ...extraEnv,
    };
    assertNoProviderCredentials(env, 'WORK_PACKET_TRANSPORT');

    const outcome = await spawnProcess(executable, [requestPath, candidatePath], {
      cwd: temp,
      env,
    });
    if (outcome.code !== 0) {
      const detail = outcome.signal ?? outcome.code ?? 'unknown';
      throw new Error(`WORK_PACKET_TRANSPORT_EXIT_FAILED:${detail}`);
    }

    if (!existsSync(candidatePath)) throw new Error('WORK_PACKET_TRANSPORT_CANDIDATE_MISSING');
    const stat = lstatSync(candidatePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('WORK_PACKET_TRANSPORT_CANDIDATE_INVALID');
    }
    const candidateBytes = readFileSync(candidatePath);
    let rawCandidate: unknown;
    try {
      rawCandidate = JSON.parse(candidateBytes.toString('utf8'));
    } catch {
      throw new Error('WORK_PACKET_TRANSPORT_CANDIDATE_JSON_INVALID');
    }
    const candidate = validateCandidate(rawCandidate, assignment, assignmentBytes);
    writeFileSync(resolve(candidateOutputPath), candidateBytes, { flag: 'wx' });
    return candidate;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
