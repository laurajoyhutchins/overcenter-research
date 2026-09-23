import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assignmentFile,
  buildAssignment,
  encodeAssignment,
  validateCandidate,
} from '../assignment-capsule.ts';

const client = process.argv[2];
if (!client) throw new Error('usage: proof.ts <native-client>');

const root = mkdtempSync(join(tmpdir(), 'overcenter-native-client-'));
try {
  const task = Buffer.from(
    '#!/bin/sh\nset -eu\ninput="$(cat "$1")"\nprintf "completed:%s\\\\n" "$input" > "$2"\n',
    'utf8',
  );
  const input = Buffer.from('hello\n', 'utf8');
  const work = {
    id: 'native-client-proof',
    revision: 'revision-1',
    status: 'EXECUTING',
    run_id: 'run-1',
    claimed_revision: 'revision-1',
    execution_generation: 1,
    packet: {
      schema: 'overcenter-agent-task/v1',
      kind: 'pure-candidate',
      source_sha: '0123456789abcdef0123456789abcdef01234567',
      command: ['./task.sh', 'input.txt', 'result.txt'],
      required_paths: ['task.sh', 'input.txt'],
      output_path: 'result.txt',
    },
  };
  const assignment = buildAssignment(work, [
    assignmentFile('task.sh', task, '100755'),
    assignmentFile('input.txt', input),
  ]);
  const assignmentBytes = encodeAssignment(assignment);
  const assignmentPath = join(root, 'assignment.json');
  const workspace = join(root, 'work');
  const candidatePath = join(root, 'candidate.json');
  writeFileSync(assignmentPath, assignmentBytes);

  execFileSync(client, ['run', assignmentPath, workspace, candidatePath], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: 'pipe',
  });

  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  validateCandidate(candidate, assignment, assignmentBytes);
  assert.equal(
    Buffer.from(candidate.output_base64, 'base64').toString('utf8'),
    'completed:hello\n',
  );

  const damaged = structuredClone(assignment);
  const inputFile = damaged.files.find((file) => file.path === 'input.txt');
  assert.ok(inputFile);
  const altered = Buffer.from(inputFile.content_base64, 'base64');
  altered[0] ^= 1;
  inputFile.content_base64 = altered.toString('base64');
  const damagedPath = join(root, 'damaged.json');
  writeFileSync(damagedPath, JSON.stringify(damaged, null, 2) + '\n');
  const damagedRun = spawnSync(
    client,
    ['run', damagedPath, join(root, 'damaged-work'), join(root, 'damaged-candidate.json')],
    { encoding: 'utf8' },
  );
  assert.notEqual(damagedRun.status, 0);
  assert.match(damagedRun.stderr, /ASSIGNMENT_FILE_DIGEST_MISMATCH/);

  const missing = structuredClone(assignment);
  missing.files = missing.files.filter((file) => file.path !== 'input.txt');
  const missingPath = join(root, 'missing.json');
  writeFileSync(missingPath, JSON.stringify(missing, null, 2) + '\n');
  const missingRun = spawnSync(
    client,
    ['run', missingPath, join(root, 'missing-work'), join(root, 'missing-candidate.json')],
    { encoding: 'utf8' },
  );
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /ASSIGNMENT_REQUIRED_FILE_MISSING:input\.txt/);

  const hostile = structuredClone(assignment);
  hostile.work.packet.output_path = '../escape';
  const hostilePath = join(root, 'hostile.json');
  writeFileSync(hostilePath, JSON.stringify(hostile, null, 2) + '\n');
  const hostileRun = spawnSync(
    client,
    ['run', hostilePath, join(root, 'hostile-work'), join(root, 'hostile-candidate.json')],
    { encoding: 'utf8' },
  );
  assert.notEqual(hostileRun.status, 0);
  assert.match(hostileRun.stderr, /ASSIGNMENT_OUTPUT_PATH_INVALID/);

  console.log(
    JSON.stringify({
      native_client: true,
      assignment_sha256: candidate.assignment_sha256,
      output_sha256: candidate.output_sha256,
      damaged_assignment_rejected: true,
      missing_input_rejected: true,
      hostile_output_path_rejected: true,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
